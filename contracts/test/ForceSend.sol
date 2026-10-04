// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev TEST HELPER ONLY. Pushes native value into a contract that has no receive function, by selfdestructing
///      inside its constructor. Used to prove that force-sent USDC cannot disturb InvoiceReceipts' accounting.
contract ForceSend {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
