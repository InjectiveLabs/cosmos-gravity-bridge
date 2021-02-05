import chai from "chai";
import { ethers, network } from "hardhat";
import { solidity } from "ethereum-waffle";
import { TestUniswapLiquidity } from "../typechain/TestUniswapLiquidity";
import { SimpleLogicBatchMiddleware } from "../typechain/SimpleLogicBatchMiddleware";
import { IERC20 } from "../typechain/IERC20";

import { deployContracts } from "../test-utils";
import {
  getSignerAddresses,
  makeCheckpoint,
  signHash,
  makeTxBatchHash,
  examplePowers,
} from "../test-utils/pure";

chai.use(solidity);
const { expect } = chai;

async function runTest() {
  //Take over the largest liquidity provider for USDC

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: ["0x0c731fb0d03211dd32a456370ad2ec3ffad46520"],
  });

  let lp_signer = await ethers.provider.getSigner(
    "0x0c731fb0d03211dd32a456370ad2ec3ffad46520"
  );
  let uniswap_router_address = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";

  // Get the usdc pool contracts as an ERC
  let usdc_eth_lp = ((await ethers.getContractAt(
    "IERC20",
    "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
    lp_signer
  )) as unknown) as IERC20;

  // USDC ethereum address
  let usdc_address = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

  // Prep and deploy contract
  // ========================
  const signers = await ethers.getSigners();
  const peggyId = ethers.utils.formatBytes32String("foo");
  // This is the power distribution on the Cosmos hub as of 7/14/2020
  let powers = examplePowers();
  let validators = signers.slice(0, powers.length);
  const powerThreshold = 6666;
  const {
    peggy,
    testERC20,
    checkpoint: deployCheckpoint,
  } = await deployContracts(peggyId, validators, powers, powerThreshold);

  // First we deploy the logic batch middleware contract. This makes it easy to call a logic
  // contract a bunch of times in a batch.
  const SimpleLogicBatchMiddleware = await ethers.getContractFactory(
    "SimpleLogicBatchMiddleware"
  );
  const logicBatch = (await SimpleLogicBatchMiddleware.deploy()) as SimpleLogicBatchMiddleware;
  // We set the ownership to peggy so that nobody else can call it.
  await logicBatch.transferOwnership(peggy.address);

  // Then we deploy the actual logic contract.
  const TestUniswapLiquidityContract = await ethers.getContractFactory(
    "TestUniswapLiquidity"
  );
  const logicContract = (await TestUniswapLiquidityContract.deploy(
    uniswap_router_address
  )) as TestUniswapLiquidity;
  // We set its owner to the batch contract.
  await logicContract.transferOwnership(logicBatch.address);

  // Transfer out to Cosmos, locking coins
  // =====================================
  await usdc_eth_lp.functions.approve(peggy.address, 10000);

  // Swap the signer of Peggy to the whale liqudity provider.
  let peggy_lp_signer = peggy.connect(lp_signer);

  await peggy_lp_signer.functions.sendToCosmos(
    usdc_eth_lp.address,
    ethers.utils.formatBytes32String("myCosmosAddress"),
    1000
  );

  // Prepare batch
  // ===============================
  // This code prepares the batch of transactions by encoding the arguments to the logicContract.
  // This batch contains 10 transactions which each:
  // - Transfer 5 coins to the logic contract
  // - Call transferTokens on the logic contract, transferring 2+2 coins to signer 20
  //
  // After the batch runs, signer 20 should have 40 coins, Peggy should have 940 coins,
  // and the logic contract should have 10 coins
  const numTxs = 10;
  const txPayloads = new Array(numTxs);

  const txAmounts = new Array(numTxs);
  for (let i = 0; i < numTxs; i++) {
    txAmounts[i] = 5;
    txPayloads[
      i
    ] = logicContract.interface.encodeFunctionData("redeemLiquidityETH", [
      usdc_address,
      5,
      0,
      0,
      await lp_signer.getAddress(),
      0,
    ]);
  }

  let invalidationNonce = 1;

  let timeOut = 4766922941000;

  // Call method
  // ===========
  // We have to give the logicBatch contract 5 coins for each tx, since it will transfer that
  // much to the logic contract.
  // We give msg.sender 1 coin in fees for each tx.
  const methodName = ethers.utils.formatBytes32String("logicCall");

  let logicCallArgs = {
    transferAmounts: [numTxs * 5], // transferAmounts
    transferTokenContracts: [usdc_eth_lp.address], // transferTokenContracts
    feeAmounts: [numTxs], // feeAmounts
    feeTokenContracts: [usdc_eth_lp.address], // feeTokenContracts
    logicContractAddress: logicBatch.address, // logicContractAddress
    payload: logicBatch.interface.encodeFunctionData("logicBatch", [
      txAmounts,
      txPayloads,
      logicContract.address,
      usdc_eth_lp.address,
    ]), // payloads
    timeOut,
    invalidationId: ethers.utils.hexZeroPad(testERC20.address, 32), // invalidationId
    invalidationNonce: invalidationNonce, // invalidationNonce
  };

  const digest = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "bytes32", // peggyId
        "bytes32", // methodName
        "uint256[]", // transferAmounts
        "address[]", // transferTokenContracts
        "uint256[]", // feeAmounts
        "address[]", // feeTokenContracts
        "address", // logicContractAddress
        "bytes", // payload
        "uint256", // timeOut
        "bytes32", // invalidationId
        "uint256", // invalidationNonce
      ],
      [
        peggyId,
        methodName,
        logicCallArgs.transferAmounts,
        logicCallArgs.transferTokenContracts,
        logicCallArgs.feeAmounts,
        logicCallArgs.feeTokenContracts,
        logicCallArgs.logicContractAddress,
        logicCallArgs.payload,
        logicCallArgs.timeOut,
        logicCallArgs.invalidationId,
        logicCallArgs.invalidationNonce,
      ]
    )
  );

  const sigs = await signHash(validators, digest);

  let currentValsetNonce = 0;

  await peggy.submitLogicCall(
    await getSignerAddresses(validators),
    powers,
    currentValsetNonce,

    sigs.v,
    sigs.r,
    sigs.s,
    logicCallArgs
  );

  //TODO Design the asserts correctly

  // expect(
  //     (await testERC20.functions.balanceOf(await signers[20].getAddress()))[0].toNumber()
  // ).to.equal(40);

  // expect(
  //   (await testERC20.functions.balanceOf(peggy.address))[0].toNumber()
  // ).to.equal(940);

  // expect(
  //     (await testERC20.functions.balanceOf(logicContract.address))[0].toNumber()
  // ).to.equal(10);

  // expect(
  //   (await testERC20.functions.balanceOf(await signers[0].getAddress()))[0].toNumber()
  // ).to.equal(9010);
}

describe("uniswap logic happy path tests", function () {
  it("runs", async function () {
    await runTest();
  });
});
