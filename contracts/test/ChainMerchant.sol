// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {InvoiceReceipts} from "../InvoiceReceipts.sol";

/// @dev TEST HELPER ONLY. A merchant that forwards what it receives by paying ANOTHER invoice from its receive hook
///      (nested payments), and tries to replay and cancel other invoices while doing so.
contract ChainMerchant {
    InvoiceReceipts public immutable invoices;
    bytes32 public nextId; // invoice to pay from the hook (zero = stop the chain)
    bytes32 public replayId; // invoice to pay again (must fail: it is already settled or unpayable)
    bytes32 public cancelId; // invoice to cancel (must fail unless it is ours and still open)
    uint256 public got;
    bool public replayOk;
    bool public cancelOk;

    constructor(InvoiceReceipts invoices_) {
        invoices = invoices_;
    }

    function set(bytes32 nextId_, bytes32 replayId_, bytes32 cancelId_) external {
        nextId = nextId_;
        replayId = replayId_;
        cancelId = cancelId_;
    }

    function register(bytes32 referenceHash, uint96 amount, uint40 due) external returns (bytes32) {
        return invoices.register(referenceHash, amount, due);
    }

    receive() external payable {
        got += msg.value;
        if (replayId != bytes32(0)) {
            try invoices.pay{value: 0}(replayId) {
                replayOk = true;
            } catch {}
        }
        if (cancelId != bytes32(0)) {
            try invoices.cancel(cancelId) {
                cancelOk = true;
            } catch {}
        }
        if (nextId != bytes32(0)) {
            invoices.pay{value: msg.value}(nextId);
        }
    }
}
