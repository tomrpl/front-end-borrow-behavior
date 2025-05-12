// WIP work, do not change this file.

import {
  DEFAULT_SLIPPAGE_TOLERANCE,
  getChainAddresses,
  Market,
  MarketId,
  MarketParams,
  MathLib,
} from "@morpho-org/blue-sdk";
import "@morpho-org/blue-sdk-viem/lib/augment";
import {
  InputBundlerOperation,
  populateBundle,
} from "@morpho-org/bundler-sdk-viem";
import { LiquidityLoader } from "@morpho-org/liquidity-sdk-viem";
import { getLast, Time } from "@morpho-org/morpho-ts";
import {
  type MaybeDraft,
  type SimulationState,
  produceImmutable,
  PublicReallocation,
} from "@morpho-org/simulation-sdk";
import {
  Address,
  createClient,
  formatUnits,
  http,
  maxUint256,
  parseEther,
} from "viem";
import { base, mainnet } from "viem/chains";
import { fetchMarketTargets } from "./fetchApiTargets.js";
import "dotenv/config";
/**
 * The default target utilization above which the shared liquidity algorithm is triggered (scaled by WAD).
 */
export const DEFAULT_SUPPLY_TARGET_UTILIZATION = 90_5000000000000000n;

export interface VaultReallocation {
  id: MarketId;
  assets: bigint;
}

export interface WithdrawalDetails {
  marketId: MarketId;
  marketParams: MarketParams;
  amount: bigint;
  sourceMarketLiquidity: bigint;
}

export interface ProcessedWithdrawals {
  withdrawalsPerVault: { [vaultAddress: string]: WithdrawalDetails[] };
  totalReallocated: bigint;
}

export interface MarketSimulationResult {
  preReallocation: {
    liquidity: bigint;
    borrowApy: bigint;
    utilization: bigint;
  };
  postReallocation: {
    liquidity: bigint;
    borrowApy: bigint;
    reallocatedAmount: bigint;
    utilization: bigint;
  };
}

export interface SimulationResults {
  targetMarket: MarketSimulationResult & {
    postBorrow: {
      liquidity: bigint;
      borrowApy: bigint;
      borrowAmount: bigint;
      utilization: bigint;
    };
  };
  sourceMarkets: {
    [marketId: string]: MarketSimulationResult;
  };
}

interface Asset {
  address: string;
  symbol: string;
}

interface AllocationMarket {
  uniqueKey: string;
  collateralAsset: Asset;
  loanAsset: Asset;
  lltv: string;
  targetBorrowUtilization: string;
  targetWithdrawUtilization: string;
  state: {
    utilization: number;
    supplyAssets: bigint;
    borrowAssets: bigint;
  };
}

interface Vault {
  address: string;
  name: string;
}

interface SharedLiquidity {
  assets: string;
  vault: Vault;
  allocationMarket: AllocationMarket;
}

export interface ReallocationResult {
  requestedLiquidity: bigint;
  currentMarketLiquidity: bigint;
  apiMetrics: {
    currentMarketLiquidity: bigint;
    reallocatableLiquidity: bigint;
    decimals: number;
    priceUsd: number;
    symbol: string;
    loanAsset: {
      address: string;
      symbol: string;
    };
    collateralAsset: {
      address: string;
      symbol: string;
    };
    lltv: bigint;
    publicAllocatorSharedLiquidity: SharedLiquidity[];
    utilization: bigint;
    maxBorrowWithoutReallocation?: bigint;
  };
  simulation?: SimulationResults;
  reallocation?: {
    withdrawals: ProcessedWithdrawals;
    liquidityNeededFromReallocation: bigint;
    reallocatableLiquidity: bigint;
    isLiquidityFullyMatched: boolean;
    liquidityShortfall: bigint;
  };
  rawTransaction?: {
    to: string;
    data: string;
    value: string;
  };
  reason?: {
    type: "success" | "error";
    message: string;
  };
}

// For displaying metrics across multiple markets efficiently, use the API
const API_URL = "https://blue-api.morpho.org/graphql";
const MARKET_QUERY = `
  query MarketByUniqueKeyReallocatable($uniqueKey: String!, $chainId: Int!) {
    marketByUniqueKey(uniqueKey: $uniqueKey, chainId: $chainId) {
      reallocatableLiquidityAssets
      publicAllocatorSharedLiquidity {
        assets
        vault {
          address
          name
        }
        allocationMarket {
          targetBorrowUtilization
          targetWithdrawUtilization
          state {
            utilization
            supplyAssets
            borrowAssets
          } 
          uniqueKey
          collateralAsset {
            address
            symbol
          }
          loanAsset {
            address
            symbol
          }
          lltv
        }
        
      }
      loanAsset {
        address
        decimals
        priceUsd
        symbol
      }
      collateralAsset {
        address
        decimals
        priceUsd
        symbol
      }
      lltv
      state {
        liquidityAssets
        utilization
      }
    }
  }
  `;

async function initializeClientAndLoader(chainId: number) {
  // Use the appropriate RPC URL based on chain ID
  const rpcUrl =
    chainId === 1
      ? process.env.RPC_URL_MAINNET
      : chainId === 8453
      ? process.env.RPC_URL_BASE
      : undefined;

  if (!rpcUrl)
    throw new Error(`No RPC URL configured for chain ID: ${chainId}`);

  const client = createClient({
    chain: chainId === 1 ? mainnet : chainId === 8453 ? base : mainnet,
    transport: http(rpcUrl, {
      retryCount: 3,
      retryDelay: 1000,
      timeout: 20000,
      batch: {
        // Only useful for Alchemy endpoints
        batchSize: 100,
        wait: 20,
      },
    }),
    batch: {
      multicall: {
        batchSize: 2048,
        wait: 50,
      },
    },
  });

  const config = getChainAddresses(chainId);
  if (!config) throw new Error(`Unsupported chain ID: ${chainId}`);
  return {
    client,
    config,
    loader: new LiquidityLoader(client, {
      maxWithdrawalUtilization: {},
      defaultMaxWithdrawalUtilization: parseEther("1"),
    }),
  };
}

async function fetchMarketMetricsFromAPI(marketId: MarketId, chainId: number) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: MARKET_QUERY,
      variables: { uniqueKey: marketId, chainId },
    }),
  });

  const data: any = await response.json();
  const marketData = data?.data?.marketByUniqueKey;

  if (!marketData) throw new Error("Market data not found");

  // Convert decimal utilization to WAD-scaled bigint
  const utilizationWad = BigInt(
    Math.floor(marketData.state.utilization * 1e18)
  );

  return {
    utilization: utilizationWad, // Now WAD-scaled
    currentMarketLiquidity: BigInt(marketData.state.liquidityAssets),
    reallocatableLiquidity: BigInt(marketData.reallocatableLiquidityAssets),
    decimals: marketData.loanAsset.decimals,
    priceUsd: marketData.loanAsset.priceUsd,
    symbol: marketData.loanAsset.symbol,
    loanAsset: marketData.loanAsset,
    collateralAsset: marketData.collateralAsset,
    lltv: marketData.lltv,
    publicAllocatorSharedLiquidity:
      marketData.publicAllocatorSharedLiquidity.map((item: any) => ({
        assets: item.assets,
        vault: item.vault,
        allocationMarket: item.allocationMarket,
      })),
  };
}

async function fetchMarketData(loader: LiquidityLoader, marketId: MarketId) {
  const rpcData = await loader.fetch(marketId);
  return {
    rpcData,
    hasReallocatableLiquidity: rpcData.withdrawals.length > 0,
  };
}

export async function fetchMarketSimulationBorrow(
  marketId: MarketId,
  chainId: number,
  requestedLiquidity: bigint
): Promise<ReallocationResult> {
  const result: ReallocationResult = {
    requestedLiquidity,
    currentMarketLiquidity: 0n,
    apiMetrics: {
      utilization: 0n,
      maxBorrowWithoutReallocation: 0n,
      currentMarketLiquidity: 0n,
      reallocatableLiquidity: 0n,
      decimals: 0,
      priceUsd: 0,
      symbol: "",
      loanAsset: { address: "", symbol: "" },
      collateralAsset: { address: "", symbol: "" },
      lltv: 0n,
      publicAllocatorSharedLiquidity: [],
    },
  };

  try {
    const userAddress: Address = "0x7f7A70b5B584C4033CAfD52219a496Df9AFb1af7"; // replace by the address of your choice

    // Initialize client, loader and fetch market targets
    const { client, loader } = await initializeClientAndLoader(chainId);
    const {
      supplyTargetUtilization,
      maxWithdrawalUtilization,
      reallocatableVaults,
    } = await fetchMarketTargets(chainId);

    // Fetch API metrics and market data
    const [apiMetrics, market] = await Promise.all([
      fetchMarketMetricsFromAPI(marketId, chainId),
      Market.fetch(marketId, client),
    ]);

    result.apiMetrics = apiMetrics;
    result.currentMarketLiquidity = market.liquidity;

    // Check if we can fetch market data
    const { rpcData } = await fetchMarketData(loader, marketId);

    if (!rpcData || !rpcData.startState) {
      result.reason = {
        type: "error",
        message: "Market data unavailable",
      };
      return result;
    }

    const startState = rpcData.startState;
    const initialMarket = startState.getMarket(marketId);

    // Validate that the market exists and has required data
    if (!initialMarket || !initialMarket.params) {
      result.reason = {
        type: "error",
        message: "Invalid market data",
      };
      return result;
    }

    const { morpho } = getChainAddresses(chainId);

    // Initialize user position for this market
    if (!startState.users[userAddress]) {
      startState.users[userAddress] = {
        address: userAddress,
        isBundlerAuthorized: false,
        morphoNonce: 0n,
      };
    }

    // Initialize user position for this market
    if (!startState.positions[userAddress]) {
      startState.positions[userAddress] = {};
    }

    // Add an empty position for this market
    startState.positions[userAddress][marketId] = {
      supplyShares: 0n,
      borrowShares: 0n,
      collateral: 0n,
      user: userAddress,
      marketId: marketId,
    };

    // Prepare user holdings for simulation
    if (!startState.holdings[userAddress]) {
      startState.holdings[userAddress] = {};
    }

    // Add collateral token to user's holdings
    startState.holdings[userAddress][initialMarket.params.collateralToken] = {
      balance: maxUint256 / 2n,
      user: userAddress,
      token: initialMarket.params.collateralToken,
      erc20Allowances: {
        morpho: maxUint256,
        permit2: 0n,
        "bundler3.generalAdapter1": maxUint256,
      },
      permit2BundlerAllowance: {
        amount: 0n,
        expiration: 0n,
        nonce: 0n,
      },
    };

    // Get bundler addresses
    const bundlerAddresses = getChainAddresses(chainId);
    const bundlerGeneralAdapter = bundlerAddresses.bundler3.generalAdapter1;

    // Initialize bundler adapter holding for the collateral token
    if (!startState.holdings[bundlerGeneralAdapter]) {
      startState.holdings[bundlerGeneralAdapter] = {};
    }

    // Add the collateral token to the bundler's holdings
    startState.holdings[bundlerGeneralAdapter][
      initialMarket.params.collateralToken
    ] = {
      balance: maxUint256, // Very large balance
      user: bundlerGeneralAdapter,
      token: initialMarket.params.collateralToken,
      erc20Allowances: {
        morpho: maxUint256,
        permit2: maxUint256,
        "bundler3.generalAdapter1": maxUint256,
      },
      permit2BundlerAllowance: {
        amount: maxUint256,
        expiration: BigInt(2 ** 48 - 1), // Far future
        nonce: 0n,
      },
    };

    // If loan token is different from collateral token, add it to bundler's holdings
    if (
      initialMarket.params.loanToken !== initialMarket.params.collateralToken
    ) {
      startState.holdings[bundlerGeneralAdapter][
        initialMarket.params.loanToken
      ] = {
        balance: maxUint256, // Very large balance
        user: bundlerGeneralAdapter,
        token: initialMarket.params.loanToken,
        erc20Allowances: {
          morpho: maxUint256,
          permit2: maxUint256,
          "bundler3.generalAdapter1": maxUint256,
        },
        permit2BundlerAllowance: {
          amount: maxUint256,
          expiration: BigInt(2 ** 48 - 1), // Far future
          nonce: 0n,
        },
      };
    }

    // Scale the requested liquidity with the correct decimals
    const scaledRequestedLiquidity =
      requestedLiquidity * BigInt(10 ** apiMetrics.decimals);

    // Create operations for this borrowAmount
    const operations: InputBundlerOperation[] = [
      {
        type: "Blue_SupplyCollateral",
        sender: userAddress,
        address: morpho,
        args: {
          id: marketId,
          assets: maxUint256 / 2n,
          onBehalf: userAddress,
        },
      },
      {
        type: "Blue_Borrow",
        sender: userAddress,
        address: morpho,
        args: {
          id: marketId,
          assets: scaledRequestedLiquidity,
          onBehalf: userAddress,
          receiver: userAddress,
          slippage: DEFAULT_SLIPPAGE_TOLERANCE,
        },
      },
    ];

    // The key part: Populate the bundle with public allocator options
    const populatedBundle = populateBundle(operations, startState, {
      publicAllocatorOptions: {
        enabled: true,
        defaultSupplyTargetUtilization: DEFAULT_SUPPLY_TARGET_UTILIZATION,
        supplyTargetUtilization,
        maxWithdrawalUtilization,
        reallocatableVaults,
      },
    });

    // Extract any MetaMorpho_PublicReallocate operations
    const publicReallocateOps = populatedBundle.operations.filter(
      (op) => op.type === "MetaMorpho_PublicReallocate"
    );
    const reallocatedAmountFromBundle = publicReallocateOps.reduce(
      (acc, op) =>
        acc +
        op.args.withdrawals.reduce(
          (sum, withdrawal) => sum + withdrawal.assets,
          0n
        ),
      0n
    );

    const utilizationPostReallocation =
      initialMarket.utilization +
      reallocatedAmountFromBundle / initialMarket.liquidity;

    // Get final state
    const finalState = getLast(populatedBundle.steps);

    const simulatedFinalMarket = finalState.getMarket(marketId);

    // Build sourceMarkets based on publicReallocateOps
    const sourceMarkets: { [marketId: string]: MarketSimulationResult } = {};

    // Process each public reallocation operation
    for (const reallocateOp of publicReallocateOps) {
      // Extract withdrawals from the operation
      const { withdrawals } = reallocateOp.args;

      // Process each withdrawal which corresponds to a source market
      for (const withdrawal of withdrawals) {
        const sourceMarketId = withdrawal.id;
        const reallocatedAmount = withdrawal.assets;

        // Get initial state for the source market
        const sourceMarketInitial = startState.getMarket(sourceMarketId);

        // Get final state for the source market
        const sourceMarketFinal = finalState.getMarket(sourceMarketId);

        // Add to sourceMarkets object
        sourceMarkets[sourceMarketId] = {
          preReallocation: {
            liquidity: sourceMarketInitial.liquidity,
            borrowApy: sourceMarketInitial.borrowApy,
            utilization: sourceMarketInitial.utilization,
          },
          postReallocation: {
            liquidity: sourceMarketFinal.liquidity,
            borrowApy: sourceMarketFinal.borrowApy,
            reallocatedAmount,
            utilization: sourceMarketFinal.utilization,
          },
        };
      }
    }

    // Add simulation results
    result.simulation = {
      targetMarket: {
        preReallocation: {
          liquidity: initialMarket.liquidity,
          borrowApy: initialMarket.borrowApy,
          utilization: initialMarket.utilization,
        },
        postReallocation: {
          liquidity: initialMarket.liquidity + reallocatedAmountFromBundle,
          borrowApy: 0n,
          reallocatedAmount: reallocatedAmountFromBundle,
          utilization: utilizationPostReallocation,
        },
        postBorrow: {
          liquidity: simulatedFinalMarket.liquidity,
          borrowApy: simulatedFinalMarket.borrowApy,
          borrowAmount: scaledRequestedLiquidity,
          utilization: simulatedFinalMarket.utilization,
        },
      },
      sourceMarkets,
    };

    result.reason = {
      type: "success",
      message:
        publicReallocateOps.length > 0
          ? "Successfully simulated with reallocation"
          : "Successfully simulated without reallocation",
    };

    return result;
  } catch (error) {
    console.error("Error in fetchMarketSimulationBorrow:", error);
    return {
      ...result,
      reason: {
        type: "error",
        message:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
    };
  }
}

export async function fetchMarketSimulationSeries(
  marketId: MarketId,
  chainId: number
): Promise<{
  percentages: number[];
  initialLiquidity: bigint;
  utilizationSeries: number[];
  apySeries: number[];
  borrowAmounts: bigint[];
  error?: string;
}> {
  try {
    const userAddress: Address = "0x7f7A70b5B584C4033CAfD52219a496Df9AFb1af7";
    const [
      { loader },
      {
        supplyTargetUtilization,
        maxWithdrawalUtilization,
        reallocatableVaults,
      },
    ] = await Promise.all([
      initializeClientAndLoader(chainId),
      fetchMarketTargets(chainId),
    ]);

    // First, check if we can fetch market data
    const { rpcData } = await fetchMarketData(loader, marketId);

    if (!rpcData || !rpcData.startState) {
      return {
        percentages: [],
        initialLiquidity: BigInt(0),
        utilizationSeries: [],
        apySeries: [],
        borrowAmounts: [],
        error: "Market does not exist or cannot be found on this chain",
      };
    }

    const startState = rpcData.startState;
    const initialMarket = startState.getMarket(marketId);

    // Validate that the market exists and has required data
    if (!initialMarket || !initialMarket.params) {
      return {
        percentages: [],
        initialLiquidity: BigInt(0),
        utilizationSeries: [],
        apySeries: [],
        borrowAmounts: [],
        error: "Invalid market data returned from chain",
      };
    }

    const { morpho } = getChainAddresses(chainId);

    // Initialize user position for this market (THIS IS THE KEY ADDITION)
    if (!startState.users[userAddress]) {
      startState.users[userAddress] = {
        address: userAddress,
        isBundlerAuthorized: false,
        morphoNonce: 0n,
      };
    }

    // Initialize user position for this market
    if (!startState.positions[userAddress]) {
      startState.positions[userAddress] = {};
    }

    // Add an empty position for this market
    startState.positions[userAddress][marketId] = {
      supplyShares: 0n,
      borrowShares: 0n,
      collateral: 0n,
      user: userAddress,
      marketId: marketId,
    };

    // Add an empty position for this market
    startState.positions[userAddress][marketId] = {
      supplyShares: 0n,
      borrowShares: 0n,
      collateral: 0n,
      user: userAddress,
      marketId: marketId,
    };

    // Prepare user holdings for simulation
    if (!startState.holdings[userAddress]) {
      startState.holdings[userAddress] = {};
    }

    startState.holdings[userAddress][initialMarket.params.collateralToken] = {
      balance: maxUint256 / 2n,
      user: userAddress,
      token: initialMarket.params.collateralToken,
      erc20Allowances: {
        morpho: maxUint256,
        permit2: 0n,
        "bundler3.generalAdapter1": maxUint256,
      },
      permit2BundlerAllowance: {
        amount: 0n,
        expiration: 0n,
        nonce: 0n,
      },
    };

    // Get bundler addresses
    const bundlerAddresses = getChainAddresses(chainId);
    const bundlerGeneralAdapter = bundlerAddresses.bundler3.generalAdapter1; // Hard-coding for now based on error

    // Initialize bundler adapter holding for the collateral token
    if (!startState.holdings[bundlerGeneralAdapter]) {
      startState.holdings[bundlerGeneralAdapter] = {};
    }

    // Add the collateral token to the bundler's holdings
    startState.holdings[bundlerGeneralAdapter][
      initialMarket.params.collateralToken
    ] = {
      balance: maxUint256, // Very large balance
      user: bundlerGeneralAdapter,
      token: initialMarket.params.collateralToken,
      erc20Allowances: {
        morpho: maxUint256,
        permit2: maxUint256,
        "bundler3.generalAdapter1": maxUint256,
      },
      permit2BundlerAllowance: {
        amount: maxUint256,
        expiration: BigInt(2 ** 48 - 1), // Far future
        nonce: 0n,
      },
    };

    // If this market involves a loan token that's different from the collateral token,
    // we should add that to the bundler's holdings as well
    if (
      initialMarket.params.loanToken !== initialMarket.params.collateralToken
    ) {
      startState.holdings[bundlerGeneralAdapter][
        initialMarket.params.loanToken
      ] = {
        balance: maxUint256, // Very large balance
        user: bundlerGeneralAdapter,
        token: initialMarket.params.loanToken,
        erc20Allowances: {
          morpho: maxUint256,
          permit2: maxUint256,
          "bundler3.generalAdapter1": maxUint256,
        },
        permit2BundlerAllowance: {
          amount: maxUint256,
          expiration: BigInt(2 ** 48 - 1), // Far future
          nonce: 0n,
        },
      };
    }

    // Define percentage steps with more granularity (every 1%)
    const percentages = Array.from({ length: 101 }, (_, i) => i);
    const maxLiquidity =
      initialMarket.liquidity +
      rpcData.withdrawals.reduce(
        (sum, withdrawal) => sum + withdrawal.assets,
        0n
      );
    // Store results
    const utilizationSeries: number[] = [];
    const apySeries: number[] = [];
    const borrowAmounts: bigint[] = [];

    // Run simulations for each percentage
    for (const percentage of percentages) {
      const borrowAmount = (maxLiquidity * BigInt(percentage)) / 100n;
      borrowAmounts.push(borrowAmount);

      // Skip if borrowAmount is 0
      if (borrowAmount === 0n && percentage > 0) continue;

      // Create operations for this borrowAmount
      const operations: InputBundlerOperation[] = [
        {
          type: "Blue_SupplyCollateral",
          sender: userAddress,
          address: morpho,
          args: {
            id: marketId,
            assets: maxUint256 / 2n,
            onBehalf: userAddress,
          },
        },
        {
          type: "Blue_Borrow",
          sender: userAddress,
          address: morpho,
          args: {
            id: marketId,
            assets: borrowAmount,
            onBehalf: userAddress,
            receiver: userAddress,
            slippage: DEFAULT_SLIPPAGE_TOLERANCE,
          },
        },
      ];

      try {
        // Simulate operations with the fetched targets
        const { steps } = populateBundle(operations, startState, {
          publicAllocatorOptions: {
            enabled: true,
            defaultSupplyTargetUtilization: DEFAULT_SUPPLY_TARGET_UTILIZATION,
            supplyTargetUtilization,
            maxWithdrawalUtilization,
            reallocatableVaults,
          },
        });

        // Get final state
        const finalState = getLast(steps);
        const simulatedMarket = finalState.getMarket(marketId);

        // Store utilization and APY values (as percentages)
        utilizationSeries.push(
          Number(formatUnits(simulatedMarket.utilization, 16))
        );
        apySeries.push(Number(formatUnits(simulatedMarket.borrowApy, 16)));
      } catch (error) {
        console.error(`Error simulating at ${percentage}%:`, error);
        // Use previous values or defaults if simulation fails
        utilizationSeries.push(
          utilizationSeries[utilizationSeries.length - 1] || 0
        );
        apySeries.push(apySeries[apySeries.length - 1] || 0);
      }
    }

    return {
      percentages,
      initialLiquidity: maxLiquidity,
      utilizationSeries,
      apySeries,
      borrowAmounts,
    };
  } catch (error) {
    console.error("Error in fetchMarketSimulationSeries:", error);
    return {
      percentages: [],
      initialLiquidity: BigInt(0),
      utilizationSeries: [],
      apySeries: [],
      borrowAmounts: [],
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}
