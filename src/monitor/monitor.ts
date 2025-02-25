import { cborDecode, getMonitoredChains, getTestChains, MonitorConfig, CheckedContract, FileService, Chain } from "@ethereum-sourcify/core";
import { VerificationService, IVerificationService } from "@ethereum-sourcify/verification";
import Logger from "bunyan";
import Web3 from "web3";
import { Transaction } from "web3-core";
import { SourceAddress } from "./util";
import { ethers } from "ethers";
import SourceFetcher from "./source-fetcher";
import SystemConfig from '../config';
import assert from 'assert';

const BLOCK_PAUSE_FACTOR = parseInt(process.env.BLOCK_PAUSE_FACTOR) || 1.1;
assert(BLOCK_PAUSE_FACTOR > 1);
const BLOCK_PAUSE_UPPER_LIMIT = parseInt(process.env.BLOCK_PAUSE_UPPER_LIMIT) || (30 * 1000); // default: 30 seconds
const BLOCK_PAUSE_LOWER_LIMIT = parseInt(process.env.BLOCK_PAUSE_LOWER_LIMIT) || (0.5 * 1000); // default: 0.5 seconds
const WEB3_TIMEOUT = parseInt(process.env.WEB3_TIMEOUT) || 3000;

function createsContract(tx: Transaction): boolean {
  return !tx.to;
}

/**
 * A monitor that periodically checks for new contracts on a single chain.
 */
class ChainMonitor {
  private chainId: string;
  private web3urls: string[];
  private web3provider: Web3;
  private sourceFetcher: SourceFetcher;
  private logger: Logger;
  private verificationService: IVerificationService;
  private running: boolean;

  private getBytecodeRetryPause: number;
  private getBlockPause: number;
  private initialGetBytecodeTries: number;

  constructor(name: string, chainId: string, web3urls: string[], sourceFetcher: SourceFetcher, verificationService: IVerificationService) {
    this.chainId = chainId;
    this.web3urls = web3urls;
    this.sourceFetcher = sourceFetcher;
    this.logger = new Logger({ name });
    this.verificationService = verificationService;

    this.getBytecodeRetryPause = parseInt(process.env.GET_BYTECODE_RETRY_PAUSE) || (5 * 1000);
    this.getBlockPause = parseInt(process.env.GET_BLOCK_PAUSE) || (10 * 1000);
    this.initialGetBytecodeTries = parseInt(process.env.INITIAL_GET_BYTECODE_TRIES) || 3;
  }

  start = async (): Promise<void> => {
    this.running = true;
    const rawStartBlock = process.env[`MONITOR_START_${this.chainId}`];

    // iterate over RPCs to find a working one; log the search result
    let found = false;
    for (const web3url of this.web3urls) {
      this.logger.info({ loc: "[MONITOR:START]", web3url }, "Attempting to connect");
      const opts = { timeout: WEB3_TIMEOUT };
      const web3provider = new Web3(new Web3.providers.HttpProvider(web3url, opts));
      try {
        const lastBlockNumber = await web3provider.eth.getBlockNumber();
        this.logger.info({ loc: "[MONITOR:START]", lastBlockNumber }, "Found a working chain");
        found = true;

        this.web3provider = web3provider;

        const startBlock = (rawStartBlock !== undefined) ? parseInt(rawStartBlock) : lastBlockNumber;
        this.processBlock(startBlock);
        break;
      } catch (err) {
        this.logger.error({ loc: "[MONITOR:START]", err: "Cannot getBlockNumber", web3url });
      }
    }

    if (!found) {
      this.logger.error({ loc: "[MONITOR:START]", err: "No working chains! Exiting!" });
    }
  }

  /**
     * Stops the monitor after executing all pending requests.
     */
  stop = (): void => {
    this.logger.info({ loc: "[MONITOR:STOP]" }, "Monitor will be stopped after pending calls finish.");
    this.running = false;
  }

  private processBlock = (blockNumber: number) => {
    this.web3provider.eth.getBlock(blockNumber, true).then(block => {
      if (!block) {
        this.adaptBlockPause("increase");

        const logObject = { loc: "[PROCESS_BLOCK]", blockNumber, getBlockPause: this.getBlockPause };
        this.logger.info(logObject, "Waiting for new blocks");
        return;
      }

      this.adaptBlockPause("decrease");

      for (const tx of block.transactions) {
        if (createsContract(tx)) {
          const address = ethers.utils.getContractAddress(tx);
          if (this.isVerified(address)) {
            this.logger.info({ loc: "[PROCESS_ADDRESS:SKIP]", address }, "Already verified");
          } else {
            this.logger.info({ loc: "[PROCESS_ADDRESS]", address }, "New contract");
            this.processBytecode(tx.input, address, this.initialGetBytecodeTries);
          }
        }
      }

      blockNumber++;

    }).catch(err => {
      this.logger.error({ loc: "[PROCESS_BLOCK:FAILED]", blockNumber }, err.message);
    }).finally(() => {
      this.mySetTimeout(this.processBlock, this.getBlockPause, blockNumber);
    });
  }

  private isVerified(address: string): boolean {
    const foundArr = this.verificationService.findByAddress(address, this.chainId);
    return !!foundArr.length;
  }

  private adaptBlockPause = (operation: "increase" | "decrease") => {
    const factor = (operation === "increase") ? BLOCK_PAUSE_FACTOR : (1 / BLOCK_PAUSE_FACTOR);
    this.getBlockPause *= factor;
    this.getBlockPause = Math.min(this.getBlockPause, BLOCK_PAUSE_UPPER_LIMIT);
    this.getBlockPause = Math.max(this.getBlockPause, BLOCK_PAUSE_LOWER_LIMIT);
  }

  private processBytecode = (creationData: string, address: string, retriesLeft: number): void => {
    if (retriesLeft-- <= 0) {
      return;
    }

    this.web3provider.eth.getCode(address).then(bytecode => {
      if (bytecode === "0x") {
        this.logger.info({ loc: "[PROCESS_BYTECODE]", address, retriesLeft }, "Empty bytecode");
        this.mySetTimeout(this.processBytecode, this.getBytecodeRetryPause, creationData, address, retriesLeft);
        return;
      }

      const numericBytecode = Web3.utils.hexToBytes(bytecode);
      try {
        const cborData = cborDecode(numericBytecode);
        const metadataAddress = SourceAddress.fromCborData(cborData);
        this.sourceFetcher.assemble(metadataAddress, contract => this.inject(contract, bytecode, creationData, address));
      } catch(err: any) {
        this.logger.error({ loc: "[GET_BYTECODE:METADATA_READING]", address }, err.message);
      }

    }).catch(err => {
      this.logger.error({ loc: "[GET_BYTECODE]", address, retriesLeft }, err.message);
      this.mySetTimeout(this.processBytecode, this.getBytecodeRetryPause, creationData, address, retriesLeft);
    });
  }

  private inject = (contract: CheckedContract, bytecode: string, creationData: string, address: string) => {
    const logObject = { loc: "[MONITOR:INJECT]", contract: contract.name, address };
    this.verificationService.inject({
      contract,
      bytecode,
      creationData,
      chain: this.chainId,
      addresses: [address]
    }).then(() => this.logger.info(logObject, "Successfully injected")
    ).catch(err => this.logger.error(logObject, err.message));
  }

  private mySetTimeout = (handler: TimerHandler, timeout: number, ...args: any[]) => {
    if (this.running) {
      setTimeout(handler, timeout, ...args);
    }
  }
}

/**
 * A monitor that periodically checks for new contracts on designated chains.
 */
export default class Monitor {
  private chainMonitors: ChainMonitor[];
  private sourceFetcher = new SourceFetcher();

  constructor(config: MonitorConfig = {}) {
    const repositoryPath = config.repository || SystemConfig.repository.path;

    const chains = config.testing ? getTestChains() :  getMonitoredChains();
    this.chainMonitors = chains.map((chain: Chain) => new ChainMonitor(
      chain.name,
      chain.chainId.toString(),
      chain.rpc,
      this.sourceFetcher,
      new VerificationService(
        new FileService(repositoryPath),
        new Logger({ name: "Monitor" })
      )
    ));
  }

  /**
     * Starts the monitor on all the designated chains.
     */
  start = async (): Promise<void> => {
    const promises = []
    for (const cm of this.chainMonitors) {
      promises.push(cm.start())
    }
    await Promise.all(promises)
  }

  /**
     * Stops the monitor after executing all the pending requests.
     */
  stop = (): void => {
    this.chainMonitors.forEach(cm => cm.stop());
    this.sourceFetcher.stop();
  }
}

if (require.main === module) {
  const monitor = new Monitor();
  monitor.start();
}