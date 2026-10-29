# Showcase

Sites that run the Paperboy engine and want to be listed. The list lives in `sites.json`. Paperboy's website reads it for the showcase, so an entry here is a public listing.

Listing is opt-in. Nothing is added without a pull request or an issue from the site's owner.

## How do I add my site?

Either:

1. Open an issue with the **Add your site to the showcase** form (`.github/ISSUE_TEMPLATE/showcase.yml`). A maintainer adds the entry.
2. Or send a pull request that adds one object to `sites.json`.

Rules:

- You must own or run the site.
- The site must publish at least one article written with the Paperboy engine.
- If your articles show the "Fact-checked by Paperboy" badge, it must link to that article's report page. The anchor is the brand name only.
- No link exchanges. Listing is not a trade for a backlink, and we do not ask you to link anywhere to be listed.
- We remove an entry on request, or when the site stops serving.

## sites.json schema

`sites.json` is an array. Each entry:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `domain` | string | yes | Bare hostname, lower case, no scheme, no path. Example: `example.com` |
| `name` | string | yes | Display name, up to 60 characters |
| `added` | string | yes | Date added, `YYYY-MM-DD` |
| `category` | string | no | One short label, such as `saas`, `local business`, `ecommerce`, `publisher` |
| `note` | string | no | One plain sentence, up to 140 characters. No claims you cannot back up |

```json
[
  {
    "domain": "example.com",
    "name": "Example Co",
    "added": "2026-11-01",
    "category": "saas",
    "note": "Publishes two fact-checked articles a week with the Paperboy engine."
  }
]
```

A JSON schema for validation:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "required": ["domain", "name", "added"],
    "additionalProperties": false,
    "properties": {
      "domain": { "type": "string", "pattern": "^[a-z0-9.-]+\\.[a-z]{2,}$" },
      "name": { "type": "string", "maxLength": 60 },
      "added": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
      "category": { "type": "string", "maxLength": 40 },
      "note": { "type": "string", "maxLength": 140 }
    }
  }
}
```

Numbers such as clicks are never stored in `sites.json`. The website shows verified Search Console numbers only for sites whose owner allowed it, from the live data.
