// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {InvoiceReceipts} from "../InvoiceReceipts.sol";

/// @dev TEST HELPER ONLY. A merchant whose receive hook needs far more than the 2300 gas of a plain transfer
///      (three fresh storage writes, about 66k gas), to prove the payout forwards all remaining gas.
contract SstoreMerchant {
    uint256 public a;
    uint256 public b;
    uint256 public c;

    function register(InvoiceReceipts invoices, bytes32 referenceHash, uint96 amount, uint40 due) external returns (bytes32) {
        return invoices.register(referenceHash, amount, due);
    }

    receive() external payable {
        a = block.number + 1;
        b = block.number + 2;
        c = block.number + 3;
    }
}
