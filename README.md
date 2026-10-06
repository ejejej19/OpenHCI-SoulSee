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


## Corresponding Links
- OpenHCI 2026: `https://2026.openhci.com/`
- topic intro: `https://docs.google.com/presentation/d/1xUU9dbr_afdRIzz_zAPt97m13knM6yv3zmDzy6sXE3k/edit?slide=id.p#slide=id.p`
- backgroud setting: `https://docs.google.com/document/d/1dhDyvuxMloYV5tt8KLq2KYFtI7d-tB_lN9rHu1ZOTAM/edit?tab=t.0`
- user interview: `https://docs.google.com/document/d/1rElun6Dwfset_RYR_jgghD_2VS8Mc3iD_Sfb0kFH9I8/edit?tab=t.rmt9ez1vrtd6#heading=h.ybtibt6k10v7`
- proposal slide: `https://docs.google.com/presentation/d/1qCfLpK0jMpeGWZamnkbu4B4vRRhIBYKV/edit?slide=id.p1#slide=id.p1`
- final presentation slide: `https://www.canva.com/design/DAHPu3ZkM7k/Z89CbXuNdaA1PLSYGonvRg/edit`
