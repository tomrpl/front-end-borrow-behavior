import { Address, _try } from "@morpho-org/blue-sdk";
import { fromEntries } from "@morpho-org/morpho-ts";

/**
 * Base URL for the Morpho Blue GraphQL API
 */
export const BLUE_API = "https://blue-api.morpho.org/graphql";

/**
 * Market target information returned from the API
 */
export interface MarketTarget {
  id: string;
  uniqueKey: string;
  targetBorrowUtilization: string;
  targetWithdrawUtilization: string;
}

/**
 * Response structure from the API for market targets query
 */
export interface ApiTargetsResponse {
  data: {
    markets: {
      items: MarketTarget[];
    };
    vaults?: {
      items: {
        id: string;
        address: string;
        publicAllocatorConfig: {
          fee: string;
        };
      }[];
    };
  };
}

/**
 * GraphQL query to fetch market targets by chain ID
 */
const MARKET_TARGETS_QUERY = `
query GetMarketTargets($chainId: Int!) {
  markets(where: { chainId_in: [$chainId] }, first: 1000) {
    items {
      id
      uniqueKey
      targetBorrowUtilization
      targetWithdrawUtilization
    }
  }
  vaults(
    where: {
      chainId_in: [$chainId]
      whitelisted: true
    }
    first: 1000
  ) {
    items {
      id
      address
      publicAllocatorConfig {
        fee
      }
    }
  }
}
`;

/**
 * Fetches market target utilization values and reallocatable vaults from the API
 * @param chainId - The blockchain chain ID (1 for Ethereum, 8453 for Base)
 * @returns Object containing supply target utilization, max withdrawal utilization, and reallocatable vaults
 */
export async function fetchMarketTargets(chainId: number) {
  try {
    const response = await fetch(BLUE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: MARKET_TARGETS_QUERY,
        variables: { chainId },
      }),
    });

    const apiResponse = (await response.json()) as ApiTargetsResponse;

    if (!apiResponse.data?.markets?.items) {
      throw new Error("Failed to fetch market targets");
    }

    // Convert target utilizations to BigInt entries
    const supplyTargetUtilization = fromEntries(
      apiResponse.data.markets.items.map(
        ({ uniqueKey, targetBorrowUtilization }) => [
          uniqueKey,
          _try(() => BigInt(targetBorrowUtilization)),
        ]
      )
    );

    const maxWithdrawalUtilization = fromEntries(
      apiResponse.data.markets.items.map(
        ({ uniqueKey, targetWithdrawUtilization }) => [
          uniqueKey,
          _try(() => BigInt(targetWithdrawUtilization)),
        ]
      )
    );

    // Get reallocatable vaults
    const reallocatableVaults =
      apiResponse.data.vaults?.items.map(({ address }) => address as Address) ||
      [];

    return {
      supplyTargetUtilization,
      maxWithdrawalUtilization,
      reallocatableVaults,
    };
  } catch (error) {
    console.error("Error fetching market targets:", error);
    // Return empty objects as fallback
    return {
      supplyTargetUtilization: {},
      maxWithdrawalUtilization: {},
      reallocatableVaults: [],
    };
  }
}

/**
 * Represents an asset in the Morpho protocol
 */
export type Asset = {
  address: string;
  decimals: bigint;
  symbol: string;
  priceUsd: number;
};

/**
 * Fetches market assets (loan and collateral) for a specific market
 * @param marketId - The unique market ID
 * @param chainId - The blockchain chain ID (1 for Ethereum, 8453 for Base)
 * @returns Object containing loan and collateral asset information
 */
export const fetchMarketAssets = async (
  marketId: string,
  chainId: number
): Promise<{ loanAsset: Asset; collateralAsset: Asset }> => {
  const query = `
    query {
    markets(where: {  uniqueKey_in: "${marketId}", chainId_in: [${chainId}]} ) {
      items {
        collateralAsset {
          address
          symbol
          decimals
          priceUsd
        }
        loanAsset {
          address
          symbol
          decimals
          priceUsd
        }
      }
    }
  }
    `;

  const response = await fetch(BLUE_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  interface MarketResponse {
    data: {
      markets: {
        items: Array<{
          loanAsset: Asset;
          collateralAsset: Asset;
        }>;
      };
    };
  }

  const data = (await response.json()) as MarketResponse;
  const market = data.data.markets.items[0];

  return {
    loanAsset: market.loanAsset,
    collateralAsset: market.collateralAsset,
  };
};
