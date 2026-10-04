// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title InvoiceReceipts
/// @notice Invoices that a payer settles in ONE transaction, with the USDC going straight to the merchant,
///         and an on-chain receipt for every payment.
///
/// @dev Written for Arc, where USDC is the native currency. Amounts are stored and reported in the 6-decimal
///      USDC unit (the unit of Arc's ERC-20 view of USDC, so 1_250_000 means 1.25 USDC). The payer attaches the
///      same amount as native value (`amount * 1e12`, because the native unit has 18 decimals) and this contract
///      forwards that value to the merchant inside the same call. No token approval and no second transaction.
///
///      Design rules, all enforced below and covered by the test suite:
///        - No owner, no admin function, no fee, no upgrade path, no delegatecall, no selfdestruct.
///        - No `receive` or `fallback`: plain transfers to this contract revert, and it never keeps a payment it
///          receives. (USDC pushed in by `selfdestruct` cannot be refused or recovered; it affects nothing.)
///        - An invoice is registered by its merchant, who is the only account that can cancel it.
///        - An invoice can be paid exactly once, in full, by exact amount, up to and including its due second.
///        - Partial payment, overpayment, double payment, payment after the due time and payment after
///          cancellation all revert with a dedicated error; on a revert the payment never leaves the payer's wallet
///          (only the gas of the failed transaction is spent).
///        - Effects are written before the payout call, so a merchant contract that re-enters finds the invoice
///          already settled.
contract InvoiceReceipts {
    /// @notice Lifecycle of an invoice. `None` means "never registered".
    enum Status {
        None,
        Open,
        Paid,
        Cancelled
    }

    /// @notice Everything stored about one invoice (three storage slots).
    struct Invoice {
        address merchant; // receives the payment; the only account that can cancel
        uint40 due; // last unix second at which the invoice can still be paid (inclusive)
        uint40 paidAt; // block timestamp of the payment, 0 while unpaid
        Status status;
        bytes32 referenceHash; // hash of the merchant's off-chain invoice text (number, description, salt)
        address payer; // account that paid, zero while unpaid
        uint96 amount; // USDC, 6 decimals
    }

    /// @notice Native units (18 decimals) per one unit of the 6-decimal USDC amount stored in an invoice.
    uint256 public constant SCALE = 1e12;

    mapping(bytes32 => Invoice) private _invoices;

    /// @notice An invoice was registered. Open until paid, cancelled, or past `due`.
    event InvoiceRegistered(
        bytes32 indexed id,
        address indexed merchant,
        bytes32 referenceHash,
        uint96 amount,
        uint40 due,
        uint40 createdAt
    );

    /// @notice RECEIPT: the invoice was paid in full and the USDC was forwarded to the merchant.
    event InvoicePaid(
        bytes32 indexed id,
        address indexed merchant,
        address indexed payer,
        bytes32 referenceHash,
        uint96 amount,
        uint40 paidAt
    );

    /// @notice The merchant cancelled an unpaid invoice. It can never be paid.
    event InvoiceCancelled(bytes32 indexed id, address indexed merchant, uint40 cancelledAt);

    error ZeroReferenceHash();
    error ZeroAmount();
    error DueNotInFuture();
    error AlreadyRegistered();
    error UnknownInvoice();
    error AlreadyPaid();
    error AlreadyCancelled();
    error InvoiceExpired(uint40 due);
    error WrongAmount(uint256 expected, uint256 sent);
    error NotMerchant();
    error TransferFailed();

    /// @notice Register an invoice for `msg.sender`, who becomes the merchant and is the one paid.
    /// @param referenceHash Non-zero hash of the off-chain invoice text. Only the hash goes on-chain.
    /// @param amount    Price in USDC with 6 decimals (1_250_000 = 1.25 USDC). Must be above zero.
    /// @param due       Unix time of the last second at which payment is accepted. Must be in the future.
    /// @return id       `keccak256(abi.encode(merchant, referenceHash))`; one merchant cannot register the same hash twice.
    function register(bytes32 referenceHash, uint96 amount, uint40 due) external returns (bytes32 id) {
        if (referenceHash == bytes32(0)) revert ZeroReferenceHash();
        if (amount == 0) revert ZeroAmount();
        if (due <= block.timestamp) revert DueNotInFuture();

        id = invoiceId(msg.sender, referenceHash);
        if (_invoices[id].status != Status.None) revert AlreadyRegistered();

        _invoices[id] = Invoice({
            merchant: msg.sender,
            due: due,
            paidAt: 0,
            status: Status.Open,
            referenceHash: referenceHash,
            payer: address(0),
            amount: amount
        });

        emit InvoiceRegistered(id, msg.sender, referenceHash, amount, due, uint40(block.timestamp));
    }

    /// @notice Pay an invoice in full. Send exactly `amount * 1e12` as the transaction value; the value is
    ///         forwarded to the merchant in this same call and emits the receipt (`InvoicePaid`).
    /// @dev    Anyone can pay; the payer is recorded as `msg.sender`. Reverts if the invoice is unknown, already
    ///         paid, cancelled or past its due time, if the value is not exactly the price, or if the merchant
    ///         cannot receive the USDC (for example a contract whose receive hook reverts, or a blocklisted
    ///         address). A reverted payment changes no state.
    function pay(bytes32 id) external payable {
        Invoice storage inv = _invoices[id];

        Status status = inv.status;
        if (status != Status.Open) {
            if (status == Status.None) revert UnknownInvoice();
            if (status == Status.Paid) revert AlreadyPaid();
            revert AlreadyCancelled();
        }
        if (block.timestamp > inv.due) revert InvoiceExpired(inv.due);

        uint96 amount = inv.amount;
        uint256 expected = uint256(amount) * SCALE;
        if (msg.value != expected) revert WrongAmount(expected, msg.value);

        // Effects first: from here on the invoice reads as paid, so any re-entry is rejected.
        address merchant = inv.merchant;
        bytes32 referenceHash = inv.referenceHash;
        inv.status = Status.Paid;
        inv.payer = msg.sender;
        inv.paidAt = uint40(block.timestamp);

        emit InvoicePaid(id, merchant, msg.sender, referenceHash, amount, uint40(block.timestamp));

        // Interaction last: the USDC goes straight to the merchant. This contract never keeps a balance.
        // The call is written inline so that no return data is ever copied into memory: a merchant contract
        // cannot make the payment more expensive by returning a large payload.
        bool ok;
        assembly ("memory-safe") {
            ok := call(gas(), merchant, callvalue(), 0, 0, 0, 0)
        }
        if (!ok) revert TransferFailed();
    }

    /// @notice Cancel an unpaid invoice. Only its merchant can do this. A cancelled invoice can never be paid
    ///         and its reference hash cannot be registered again by the same merchant (use a new one).
    function cancel(bytes32 id) external {
        Invoice storage inv = _invoices[id];

        Status status = inv.status;
        if (status == Status.None) revert UnknownInvoice();
        if (msg.sender != inv.merchant) revert NotMerchant();
        if (status == Status.Paid) revert AlreadyPaid();
        if (status == Status.Cancelled) revert AlreadyCancelled();

        inv.status = Status.Cancelled;

        emit InvoiceCancelled(id, msg.sender, uint40(block.timestamp));
    }

    /// @notice Read an invoice. A never-registered id returns all zeros (`status == None`). An `Open` invoice
    ///         whose `due` is in the past can no longer be paid; this view does not change its stored status.
    function getInvoice(bytes32 id) external view returns (Invoice memory) {
        return _invoices[id];
    }

    /// @notice The id an invoice gets: `keccak256(abi.encode(merchant, referenceHash))`. Computable off-chain, so a
    ///         pay link can be built before the registration transaction is mined.
    function invoiceId(address merchant, bytes32 referenceHash) public pure returns (bytes32) {
        return keccak256(abi.encode(merchant, referenceHash));
    }
}
