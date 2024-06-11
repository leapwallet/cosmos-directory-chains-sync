import { Bech32Address } from '@keplr-wallet/cosmos';
import type { ChainInfo, Currency } from '@keplr-wallet/types';
import { createClient, createTestnetClient, type DirectoryClient } from 'cosmos-directory-client';
import pmap from 'p-map';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import invariant from 'tiny-invariant';
import 'dotenv/config';

const makeRecord = async (client: DirectoryClient, { filter = '' }: { filter?: string } = {}) => {
  const paths = filter
    ? filter.split(',').map((path) => ({ path }))
    : await client.fetchChains().then((c) => c.chains.map(({ path }) => ({ path })));

  const chains = await pmap(paths, async (c) => client.fetchChain(c.path).then((x) => x.chain), {
    concurrency: 4,
  });

  const record: Record<string, ChainInfo> = {};

  chains.forEach((chain) => {
    try {
      const apis = chain.apis;
      if (!apis || !apis.rest?.[0] || !apis.rpc?.[0]) {
        throw new Error(`⚠️\t${chain.name} has no REST/RPC endpoints, skipping codegen...`);
      }

      if (!chain.assets) {
        throw new Error(`⚠️\t${chain.name} has no assets, skipping codegen...`);
      }
      const mainAsset = chain.assets[0];

      const nativeCurrency: Currency = {
        coinDenom: mainAsset.denom_units[mainAsset.denom_units.length - 1].denom,
        coinMinimalDenom: mainAsset.denom_units[0].denom,
        coinDecimals: mainAsset.denom_units[mainAsset.denom_units.length - 1].exponent,
        coinGeckoId: mainAsset.coingecko_id,
      };

      const feeCurrencies = chain.fees?.fee_tokens.map((token) => {
        const isGasPriceStepAvailable =
          token.low_gas_price && token.average_gas_price && token.high_gas_price;

        if (isGasPriceStepAvailable) {
          return {
            coinDenom:
              chain.assets?.find((asset) => asset.denom === token.denom)?.denom_units.at(-1)
                ?.denom || token.denom,
            coinMinimalDenom:
              chain.assets?.find((asset) => asset.denom === token.denom)?.denom_units[0]?.denom ||
              token.denom,
            coinDecimals: Number(
              chain.assets?.find((asset) => asset.denom === token.denom)?.decimals
            ),
            coinGeckoId:
              chain.assets?.find((asset) => asset.denom === token.denom)?.coingecko_id || '',
            gasPriceStep: {
              low: Number(token.low_gas_price),
              average: Number(token.average_gas_price),
              high: Number(token.high_gas_price),
            },
          };
        }

        return {
          coinDenom:
            chain.assets?.find((asset) => asset.denom === token.denom)?.denom_units.at(-1)?.denom ||
            token.denom,
          coinMinimalDenom:
            chain.assets?.find((asset) => asset.denom === token.denom)?.denom_units[0]?.denom ||
            token.denom,
          coinDecimals: Number(
            chain.assets?.find((asset) => asset.denom === token.denom)?.decimals
          ),
          coinGeckoId:
            chain.assets?.find((asset) => asset.denom === token.denom)?.coingecko_id || '',
        };
      });

      if (!feeCurrencies) {
        throw new Error(`⚠️\t${chain.name} has no fee currencies, skipping codegen...`);
      }

      record[chain.path] = {
        chainId: chain.chain_id,
        currencies: chain.assets.map((asset) => ({
          coinDenom: asset.denom_units[asset.denom_units.length - 1].denom,
          coinMinimalDenom: asset.denom_units[0].denom,
          coinDecimals: asset.denom_units[asset.denom_units.length - 1].exponent,
          coinGeckoId: asset.coingecko_id,
        })),
        rest: apis.rest[0].address || '',
        rpc: apis.rpc[0].address || '',
        bech32Config: Bech32Address.defaultBech32Config(chain.bech32_prefix),
        chainName: chain.chain_name,
        feeCurrencies,
        stakeCurrency: nativeCurrency,
        bip44: {
          coinType: chain.slip44 ?? 0,
        },
      };
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  });

  return record;
};

const generate = async () => {
  console.log(`⏳\tGenerating chain list from cosmos.directory...`);

  const [mainnetRecord, testnetRecord] = await Promise.all([
    makeRecord(createClient()),
    makeRecord(createTestnetClient()),
  ]);

  const chains = {
    mainnet: mainnetRecord,
    testnet: testnetRecord,
  };

  console.log(
    '✨\tGenerate complete! You can import `mainnetChains` and `testnetChains` from "graz/chains".\n'
  );

  return chains;
};

async function uploadToS3(
  key: string,
  body: string,
  options: {
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
  }
) {
  const command = new PutObjectCommand({
    ACL: 'public-read',
    Bucket: options.bucketName,
    Key: key,
    Body: body,
    ContentType: 'application/json',
  });
  const s3Client = new S3Client({
    region: 'auto',
    credentials: options,
  });
  await s3Client.send(command);
  console.log(`📤 Uploaded ${key} to S3 bucket ${options.bucketName}.`);
}

async function createCloudFrontInvalidation(credentials: {
  accessKeyId: string;
  secretAccessKey: string;
  distributionId: string;
  awsRegion: string;
}) {
  const command = new CreateInvalidationCommand({
    DistributionId: credentials.distributionId,
    InvalidationBatch: {
      CallerReference: new Date().toISOString(),
      Paths: {
        Quantity: 1,
        Items: ['/cosmos-directory-cache/*'],
      },
    },
  });
  const cloudFrontClient = new CloudFrontClient({
    region: credentials.awsRegion,
    credentials,
  });
  await cloudFrontClient.send(command);
  console.log('✅ CloudFront cache invalidation created.');
}

const main = async (options: {
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  distributionId: string;
  awsRegion: string;
}) => {
  const chainsData = await generate();

  // Upload chains data to S3
  await uploadToS3('cosmos-directory-cache/graz-chains.json', JSON.stringify(chainsData), options);

  await createCloudFrontInvalidation(options);
};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      AWS_ACCESS_KEY_ID: string | undefined;
      AWS_SECRET_ACCESS_KEY: string | undefined;
      AWS_REGION: string | undefined;
      CLOUDFRONT_DISTRIBUTION_ID: string | undefined;
      S3_BUCKET_NAME: string | undefined;
    }
  }
}

invariant(process.env.AWS_ACCESS_KEY_ID, 'AWS_ACCESS_KEY_ID missing in process.env');
invariant(process.env.AWS_SECRET_ACCESS_KEY, 'AWS_SECRET_ACCESS_KEY missing in process.env');
invariant(process.env.AWS_REGION, 'AWS_REGION missing in process.env');
invariant(
  process.env.CLOUDFRONT_DISTRIBUTION_ID,
  'CLOUDFRONT_DISTRIBUTION_ID missing in process.env'
);
invariant(process.env.S3_BUCKET_NAME, 'S3_BUCKET_NAME missing in process.env');

main({
  bucketName: process.env.S3_BUCKET_NAME,
  distributionId: process.env.CLOUDFRONT_DISTRIBUTION_ID,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  awsRegion: process.env.AWS_REGION,
})
  .then(() => {
    console.log('🎉 CRON Job completed successfully.');
    process.exit(0);
  })
  .catch((error) => {
    console.log('❌ CRON Job failed.');
    console.error(error);
    process.exit(1);
  });
