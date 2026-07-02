# API Documentation

## POST /api/message
Channel-agnostic entry point.

### Request Body
```json
{
  "channel": "PWA",
  "userId": "session-uuid",
  "message": "hello"
}
```

### Response Body
```json
{
  "reply": "Hello! How can I help you today?",
  "sessionState": {},
  "agentHandoff": false
}
```
