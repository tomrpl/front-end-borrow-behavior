import { ChainId, MarketId } from "@morpho-org/blue-sdk";
import { formatUnits } from "viem";
import { fetchMarketSimulationSeries } from "./publicAllocator.js";
import { fetchMarketAssets } from "./fetchApiTargets.js";
import chalk from "chalk";
import { table } from "table";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// Default market ID and chain ID
// Ethereum: Example: 0xc84cdb5a63207d8c2e7251f758a435c6bd10b4eaefdaf36d7650159bf035962e
// Base: Example: 0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836
const DEFAULT_MARKET_ID =
  "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
const DEFAULT_CHAIN_ID = 8453; // Base chain

/**
 * Main function to simulate and display market borrowing rates
 * Fetches market data, calculates borrow rates at different utilization levels,
 * and displays the results in a formatted table
 */
async function main() {
  // Parse command line arguments
  const argv = await yargs(hideBin(process.argv))
    .option("marketId", {
      alias: "m",
      type: "string",
      description: "Market ID to simulate",
      default: DEFAULT_MARKET_ID,
    })
    .option("chainId", {
      alias: "c",
      type: "number",
      description: "Chain ID (1 for Ethereum mainnet, 8453 for Base)",
      default: DEFAULT_CHAIN_ID,
    })
    .option("steps", {
      alias: "s",
      type: "number",
      description: "Number of percentage steps to display (default is 10)",
      default: 10,
    })
    .help()
    .alias("help", "h").argv;

  const marketId = argv.marketId as MarketId;
  const chainId = argv.chainId as ChainId;
  const steps = argv.steps;

  console.log(
    chalk.cyan(
      `\nFetching market simulation data for market ${marketId} on chain ${chainId}...\n`
    )
  );

  try {
    // Fetch market assets to get token symbols and decimals
    const marketAsset = await fetchMarketAssets(marketId, chainId);
    if (!marketAsset || !marketAsset.loanAsset) {
      console.error(
        chalk.red(
          "Failed to fetch market assets or invalid asset structure. Please verify that market ID exists on the specified chain."
        )
      );
      process.exit(1);
    }

    // Fetch simulation series data
    const simulationData = await fetchMarketSimulationSeries(marketId, chainId);
    if (simulationData.error) {
      console.error(
        chalk.red(`Error fetching simulation data: ${simulationData.error}`)
      );
      process.exit(1);
    }

    // Extract token info
    const tokenSymbol = marketAsset.loanAsset.symbol || "Unknown";
    const tokenDecimals = marketAsset.loanAsset.decimals || 18n;
    const tokenPrice = marketAsset.loanAsset.priceUsd || 0;

    // Display market information
    console.log(
      chalk.green(`Market simulation data for ${tokenSymbol} market`)
    );
    console.log(
      chalk.yellow(
        `Max Liquidity: ${formatUnits(
          simulationData.initialLiquidity,
          Number(tokenDecimals)
        )} ${tokenSymbol}`
      )
    );
    if (tokenPrice > 0) {
      console.log(
        chalk.yellow(
          `Max Liquidity (USD): $${(
            Number(
              formatUnits(
                simulationData.initialLiquidity,
                Number(tokenDecimals)
              )
            ) * tokenPrice
          ).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
        )
      );
    }
    console.log("");

    // Create display table data
    const tableData = [
      [
        chalk.bold("Index"),
        chalk.bold("Percentage (%)"),
        chalk.bold("Borrow Amount"),
        tokenPrice > 0 ? chalk.bold("Borrow Amount (USD)") : "",
        chalk.bold("Utilization (%)"),
        chalk.bold("APY (%)"),
      ],
    ];

    // Select data points to display (based on the steps)
    const totalPoints = simulationData.percentages.length;
    const stepSize = Math.floor(totalPoints / steps);
    const indicesToShow = Array.from({ length: steps + 1 }, (_, i) =>
      Math.min(i * stepSize, totalPoints - 1)
    );

    // Add data for specified steps
    for (const idx of indicesToShow) {
      const percentage = simulationData.percentages[idx];
      const borrowAmount = simulationData.borrowAmounts[idx];
      const utilization = simulationData.utilizationSeries[idx];
      const apy = simulationData.apySeries[idx];

      const formattedBorrowAmount = formatUnits(
        borrowAmount,
        Number(tokenDecimals)
      );
      const borrowAmountUsd =
        tokenPrice > 0 ? Number(formattedBorrowAmount) * tokenPrice : null;

      tableData.push([
        idx.toString(),
        percentage.toFixed(2),
        `${Number(formattedBorrowAmount).toLocaleString(undefined, {
          maximumFractionDigits: 4,
        })} ${tokenSymbol}`,
        borrowAmountUsd
          ? `$${borrowAmountUsd.toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })}`
          : "",
        utilization.toFixed(2),
        apy.toFixed(2),
      ]);
    }

    // Configure table options
    const tableConfig = {
      drawHorizontalLine: (index: number, size: number) => {
        return index === 0 || index === 1 || index === size;
      },
    };

    // Display the table with title as a separate log
    console.log(
      chalk.bold(`\n${tokenSymbol} Market Simulation (Chain ID: ${chainId})\n`)
    );
    console.log(table(tableData, tableConfig));

    // Display a note about more detailed data
    console.log(
      chalk.gray(
        "Note: This table shows a subset of data points. To see all data points, use the --steps option with a higher value."
      )
    );
    console.log(chalk.gray("For example: yarn start --steps 20"));
  } catch (error) {
    console.error(chalk.red("Error running simulation:"));
    if (error instanceof Error) {
      console.error(chalk.red(error.message));
      console.error(chalk.gray(error.stack));
    } else {
      console.error(chalk.red(String(error)));
    }
    process.exit(1);
  }
}

// Run the main function
main().catch((error) => {
  console.error(chalk.red("Unhandled error:"));
  console.error(error);
  process.exit(1);
});
