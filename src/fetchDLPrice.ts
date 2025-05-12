import { getAddress } from "viem";
import { getCurrentTimestamp } from "./utils.js";

export interface DefiLlamaResponse {
  coins: {
    [key: string]: {
      decimals: number;
      symbol: string;
      price: number;
      timestamp: number;
      confidence: number;
    };
  };
}

export interface AssetPriceInfoDL {
  decimals: number;
  symbol: string;
  price: number;
  timestamp: number;
  confidence: number;
}
// Define supported chains and their mappings
export const SUPPORTED_CHAINS: { [key: number]: string } = {
  1: "ethereum",
  10: "optimism",
  130: "unichain",
  137: "polygon",
  146: "sonic",
  252: "fraxtal",
  480: "wc", // World Chain
  8453: "base",
  34443: "mode",
  42161: "arbitrum",
  // 43111: "hemi", dl doesn't support it
  57073: "ink",
  534352: "scroll",
  21000000: "corn",
};

/**
 * Fetches the current price of an asset from DefiLlama
 * @param address The asset's contract address
 * @param chainId The chain ID where the asset is deployed
 * @returns Asset price information or null if not found
 */
export async function fetchAssetPriceDL(
  address: string,
  chainId: number
): Promise<AssetPriceInfoDL | null> {
  try {
    // Get chain name from mapping
    const chainName = SUPPORTED_CHAINS[chainId];
    if (!chainName) {
      console.warn(`Unsupported chain ID: ${chainId}`);
      return null;
    }

    // Checksum address
    const normalizedAddress = getAddress(address);

    // Construct DefiLlama API URL
    const url = `https://coins.llama.fi/prices/current/${chainName}:${normalizedAddress}?searchWidth=4h`;

    // Fetch price data
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`HTTP error! status: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as DefiLlamaResponse;
    const coinKey = `${chainName}:${normalizedAddress}`;
    const coinData = data.coins[coinKey];

    if (!coinData) {
      console.warn(`No price data found for ${coinKey}`);
      return null;
    }

    // Verify timestamp is recent (within last 24 hours)
    const currentTimestamp = getCurrentTimestamp();
    if (currentTimestamp - coinData.timestamp > 24 * 60 * 60) {
      console.warn(`Price data for ${coinKey} is stale`);
      return null;
    }

    return {
      decimals: coinData.decimals,
      symbol: coinData.symbol,
      price: coinData.price,
      timestamp: coinData.timestamp,
      confidence: coinData.confidence,
    };
  } catch (error) {
    console.error("Error fetching price from DefiLlama:", error);
    return null;
  }
}
