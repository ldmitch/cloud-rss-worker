# cloud-rss-worker

A backend service for fetching, parsing, and storing RSS/ATOM feeds in Cloudflare KV. Built with TypeScript and Cloudflare Workers.

## Overview

Cloud RSS Worker is the backend component for [Cloud RSS](https://github.com/ldmitch/cloud-rss), fetching articles from various RSS/ATOM feeds every 30 minutes and storing them in Cloudflare KV storage. The Worker parses feed content, extracts relevant article metadata, and makes this data available to the front-end application.

The service maintains a rolling 48-hour window of articles. All fetching happens through Cloudflare Workers, providing privacy benefits by masking user IP addresses from feed providers.

## Setup and local development

### Prerequisites

- pnpm

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

4. Update [sources.json](./sources.json) as needed
- Add or remove feed URLs
- Each entry must have a `title` and `url` field, where the `url` is a valid RSS/ATOM feed

5. Start the development server, exposing an endpoint to manual trigger the scheduled function
```bash
pnpm run dev
```

6. Manually trigger the scheduled function
```bash
pnpm run cron
```

### Deployment to Cloudflare Pages

The project is configured to deploy to Cloudflare Workers. You'll need to set up:

1. A Cloudflare Workers project linked to your Cloud RSS Worker repository
2. A Cloudflare Workers paid compute plan (necessary for extended scheduled function compute time)
3. A KV namespace named `ARTICLES` to store article previews
4. The KV namespace ID in [`wrangler.jsonc`](./wrangler.jsonc)
5. The route pattern in [`wrangler.jsonc`](./wrangler.jsonc) to reflect your API endpoint

## License

[MIT License](./LICENSE.md)

## Contributing

Contributions are welcome-- feel free to submit a pull request.
