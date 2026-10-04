// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {InvoiceReceipts} from "../InvoiceReceipts.sol";

/// @dev TEST HELPER ONLY. A smart-contract payer (stand-in for a Safe or a smart wallet).
contract PayerContract {
    function payInvoice(InvoiceReceipts invoices, bytes32 id) external payable {
        invoices.pay{value: msg.value}(id);
    }

    receive() external payable {}
}
