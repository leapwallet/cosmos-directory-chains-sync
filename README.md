# Introduction

This is a script that gets the cosmos.directory data from GitHub and converts it into a JSON file, stores it on S3 and invalidates the cloudfront cache.

The generated data is of the following type -

```ts
import type { ChainInfo } from '@keplr-wallet/types'

type GeneratedData = {
  mainnet: Record<string, ChainInfo>
  testnet: Record<string, ChainInfo>
}
```

The generated data is saved in an leap's assets s3 bucket and served via cloudfront.

# Usage

## Install Dependencies

```sh
yarn install
```

## Build TS Script
  
```sh
yarn build
```

## Load the Environment Variables

```sh
export AWS_REGION="..."
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export S3_BUCKET_NAME="..."
export CLOUDFRONT_DISTRIBUTION_ID="..."
```

> Note: Missing environment variables will cause the script to throw an error.

## Run the Generated JS

```sh
yarn start
```

# Data Usage

The data is served via cloudfront and can be accessed via the following path -

`/cosmos-directory-cache/graz-chains.json`
