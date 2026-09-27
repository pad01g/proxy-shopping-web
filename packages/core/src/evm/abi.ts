import { parseAbi } from 'viem';

export const safeAbi = parseAbi([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function nonce() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function isModuleEnabled(address module) view returns (bool)',
  'event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)',
  'event ExecutionFailure(bytes32 indexed txHash, uint256 payment)',
]);

export const safeProxyFactoryAbi = parseAbi([
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'function proxyCreationCode() pure returns (bytes)',
  'event ProxyCreation(address indexed proxy, address singleton)',
]);

export const multiSendCallOnlyAbi = parseAbi(['function multiSend(bytes transactions) payable']);

export const psSafeSetupAbi = parseAbi([
  'function setup(address module, address token, address user, address shopper, uint64 t1, uint64 t2)',
]);

export const psEscrowModuleAbi = parseAbi([
  'function claimByShopper(address safe)',
  'function refundToUser(address safe)',
  'function config(address safe) view returns (address token, address user, address shopper, uint64 t1, uint64 t2)',
]);

export const erc20Abi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function mint(address to, uint256 amount)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const aggregatorV3Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function setAnswer(int256 answer)',
]);

export const psBondAbi = parseAbi([
  'function deposit(uint256 amount)',
  'function slash(address escrow, address to, uint256 amount)',
  'function bondOf(address escrow) view returns (uint256)',
  'function requestWithdraw()',
  'function withdraw()',
]);
