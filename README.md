# OpenHCI

Production source for `https://openhci.cechung.com`.

The deployed app lives in `site/`:

- `site/public/` - static pages served on the domain.
- `site/src/index.js` - Cloudflare Worker API proxy for AI routes.
- `site/wrangler.jsonc` - Worker, assets, vars, and route config.

## Local Development

```bash
cd site
npm install
npm run dev
```

Open the local Wrangler URL. Camera features work best on localhost or HTTPS.

## Deploy

Cloudflare Workers Builds deploys the repository branches to separate sites:

- `develop` -> `https://staging.openhci.cechung.com`
- `main` -> `https://openhci.cechung.com`

Create feature branches from `develop`. Merge them back into `develop`, verify
the staging site, then open a release PR from `develop` to `main`.

Manual production fallback:

```bash
cd site
npm run deploy
```

Manual staging fallback:

```bash
cd site
npm run deploy:staging
```

Do not commit `.dev.vars` or real API keys.
