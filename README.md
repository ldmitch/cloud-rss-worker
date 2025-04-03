# cloud-rss-worker

A backend service for fetching, parsing, and storing RSS/ATOM feeds in Cloudflare KV. Built with TypeScript and Cloudflare Workers.

## Overview

Cloud RSS Worker is the backend component for [Cloud RSS](https://github.com/ldmitch/cloud-rss), fetching articles from various RSS/ATOM feeds every 30 minutes and storing them in Cloudflare KV storage. The Worker parses feed content, extracts relevant article metadata, and makes this data available to the front-end application.

The service maintains a rolling 48-hour window of articles, ensuring that the content is always fresh and relevant. All article fetching happens through Cloudflare Workers, providing privacy benefits by masking user IP addresses from feed providers.

## Features

- **Automatic feed updates**: Runs on a 30-minute schedule to fetch the latest content from all configured sources
- **Multi-format support**: Handles both RSS and ATOM feed formats
- **Privacy-preserving**: All content is fetched via Cloudflare Workers, not directly from user devices
- **HTML entity decoding**: Properly handles HTML entities in feed content
- **Content filtering**: Only stores articles from the past 48 hours
- **Error resilience**: Includes retry logic for KV operations and graceful error handling for feed parsing
- **Low maintenance**: Once deployed, requires minimal intervention

## Setup and local development

### Prerequisites

- Node.js and pnpm
- A Cloudflare account

### Local development

1. Clone the repository
```bash
git clone https://github.com/ldmitch/cloud-rss-worker
cd cloud-rss-worker
```

2. Install dependencies
```bash
pnpm install
```

3. Generate types
```bash
pnpm run cf-typegen
```

4. Start the development server with scheduled execution
```bash
pnpm run dev
```

5. Manually trigger the scheduled function
```bash
pnpm run cron
```

### Deployment to Cloudflare Pages

The project is configured to deploy to Cloudflare Workers. You'll need to set up:

1. A Cloudflare Workers project linked to your Cloud RSS Worker repository
2. A KV namespace named `ARTICLES` to store article previews
3. The KV namespace ID in [`wrangler.jsonc`](./wrangler.jsonc)
4. The route pattern in [`wrangler.jsonc`](./wrangler.jsonc) to reflect your API endpoint

## License

[MIT License](./LICENSE.md)

## Contributing

Contributions are welcome-- feel free to submit a pull request.
