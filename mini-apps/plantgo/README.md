# PlantGo mini-app

Read-only lookup of plants and community plant sightings from [PlantGo](https://plantgo.club), a citizen-science plant app. Generic path: `auth.mode` `none`, every operation `class: "read"`. No credential or resident identity is ever sent.

Endpoint: `https://plantgo.gptindia.pro/mcp` (stateless MCP over HTTPS, protocol `2025-06-18`, no redirects). Server code: `backend/mcp.js` in the PlantGo repo.

| Operation | Sent to plantgo.gptindia.pro | Returned |
|---|---|---|
| `plantgo.search_sightings` | the search text and limit the agent supplies | public sightings: plant names, family, category, description, vouch count, location rounded to about 1 km, date. No user names, user ids or photos. |
| `plantgo.search_species` | the search text and limit | species id, names, family, category, rarity, description |
| `plantgo.get_species` | one species id | species details (description, edible and medicinal notes, flowering and fruiting season) |

**Third party that receives data:** PlantGo (plantgo.gptindia.pro), operated by the app owner. It receives only the arguments above.

**Retention:** PlantGo keeps ordinary web server access logs (time, requesting IP, request path). Calls never write to PlantGo's database. Search text is not stored beyond those logs.

**Errors:** bodies are `{"code": ..., "detail": ...}` with `invalid_arguments`, `not_found` or `unavailable`.

**Owner:** GitHub `agnelvishal`.
