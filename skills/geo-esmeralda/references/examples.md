# Examples

Create village content:

```bash
geo-edge-esmeralda create --event-id <event-id> --kind comment --client-request-id <stable-id> --content 'Several attendees connected the session to local-first data sharing.'
geo-edge-esmeralda create --venue-id <venue-id> --kind note --client-request-id <stable-id> --content 'The side conversation after lunch focused on practical onboarding for new contributors.'
geo-edge-esmeralda create --track-id <track-id> --kind essay --title 'Coordination notes from week one' --client-request-id <stable-id> --content 'A synthesis of what participants have been learning about shared infrastructure.'
geo-edge-esmeralda create --kind project_pitch --title 'Mutual aid map' --client-request-id <stable-id> --content 'Looking for collaborators on an offline-capable resource map.'
geo-edge-esmeralda create --event-id <event-id> --kind photo --file ./photo.jpg --client-request-id <stable-id> --content 'Whiteboard from the protocol design session.'
```

Community knowledge and relations:

```bash
geo-edge-esmeralda fixed --tool community_search --input '{"query":"housing coordination","limit":10}'
geo-edge-esmeralda fixed --tool recent_messages --input '{"limit":10}'
geo-edge-esmeralda fixed --tool list_content --input '{"scopeKind":"event","scopeId":"<event-id>","limit":10}'
geo-edge-esmeralda fixed --tool get_event_content --input '{"eventId":"<event-id>","limit":20}'
geo-edge-esmeralda fixed --tool list_idea_links --input '{"limit":20}'
```

Ontology:

```bash
geo-edge-esmeralda ontology
```

Native read-only query:

```bash
geo-edge-esmeralda native --query 'MATCH (c:ContentItem) WHERE c.popupId = $popupId RETURN c.id AS id, c.title AS title, c.kind AS kind LIMIT 20'
```
