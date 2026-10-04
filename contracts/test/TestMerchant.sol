// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {InvoiceReceipts} from "../InvoiceReceipts.sol";

/// @dev TEST HELPER ONLY, never deployed for real. A smart-contract merchant whose behaviour when it receives
///      USDC can be switched, to prove how InvoiceReceipts reacts to hostile or broken merchants.
contract TestMerchant {
    enum Mode {
        Accept, // take the money
        Reject, // revert in the receive hook
        Reenter, // try to pay / cancel / register again while being paid
        BurnGas, // consume all forwarded gas
        ReturnBomb, // answer with a large return payload
        RevertBomb // revert with a 100 kB payload
    }

    InvoiceReceipts public immutable invoices;
    Mode public mode;
    bytes32 public targetId;

    uint256 public received;
    bool public reenterPayOk;
    bytes4 public reenterPaySelector;
    bool public reenterCancelOk;
    bytes4 public reenterCancelSelector;
    bool public reenterRegisterOk;
    bool public hookRan;

    constructor(InvoiceReceipts invoices_) {
        invoices = invoices_;
    }

    function setMode(Mode mode_, bytes32 targetId_) external {
        mode = mode_;
        targetId = targetId_;
    }

    function register(bytes32 referenceHash, uint96 amount, uint40 due) external returns (bytes32) {
        return invoices.register(referenceHash, amount, due);
    }

    function cancel(bytes32 id) external {
        invoices.cancel(id);
    }

    receive() external payable {
        hookRan = true;
        if (mode == Mode.Reject) revert("merchant rejects");
        if (mode == Mode.RevertBomb) {
            assembly {
                revert(0, 100000)
            }
        }
        if (mode == Mode.BurnGas) {
            assembly {
                invalid()
            }
        }
        received += msg.value;
        if (mode == Mode.ReturnBomb) {
            assembly {
                return(0, 100000)
            }
        }
        if (mode == Mode.Reenter) {
            // 1. pay the same invoice a second time with the money that just arrived
            try invoices.pay{value: msg.value}(targetId) {
                reenterPayOk = true;
            } catch (bytes memory reason) {
                reenterPaySelector = bytes4(reason);
            }
            // 2. cancel the invoice that is being paid
            try invoices.cancel(targetId) {
                reenterCancelOk = true;
            } catch (bytes memory reason) {
                reenterCancelSelector = bytes4(reason);
            }
            // 3. register a different invoice from inside the hook (allowed and harmless)
            try invoices.register(keccak256("registered from the hook"), 1, uint40(block.timestamp + 1 days)) {
                reenterRegisterOk = true;
            } catch {}
        }
    }
}
