# Truth Social Client

A TypeScript client for interacting with Truth Social's API, built on top of the @ai16z/eliza framework for AI-powered social media interactions.

## System Overview

This client provides automated interaction capabilities with Truth Social, including:

- Posting and responding to content
- Processing mentions and interactions
- Searching and engaging with relevant content
- Managing rate limits and API interactions

### Core Components

1. **API Layer** (`api.ts`)
   - Handles direct communication with Truth Social's API
   - Manages authentication and rate limiting
   - Provides base methods for posts, likes, reposts, etc.

2. **Base Client** (`base.ts`)
   - Provides foundational client functionality
   - Manages state and caching
   - Handles timeline and post fetching

3. **Post Management** (`post.ts`)
   - Handles post creation and processing
   - Manages periodic posting
   - Processes post actions and interactions

4. **Interactions** (`interactions.ts`)
   - Manages user interactions and responses
   - Handles conversation threading
   - Controls engagement limits and timeouts

5. **Search** (`search.ts`)
   - Implements search functionality
   - Manages topic-based engagement
   - Controls post selection and relevance

6. **Environment** (`environment.ts`)
   - Manages configuration and settings
   - Validates environment variables
   - Sets operational parameters

### Supporting Files

- **Types** (`types.ts`): TypeScript interfaces and types
- **Utils** (`utils.ts`): Shared utilities and helper functions
- **Index** (`index.ts`): Main entry point and client initialization

## Requirements

### Dependencies

- Node.js 14+
- TypeScript 4.5+
- @ai16z/eliza framework
- axios
- date-fns
- zod

### Environment Variables

- TRUTHSOCIAL_DRY_RUN: Boolean, if true, the client will not post or interact with Truth Social
- TRUTHSOCIAL_USERNAME: String, the username of the Truth Social account
- TRUTHSOCIAL_PASSWORD: String, the password of the Truth Social account
- MAX_TRUTH_LENGTH: Number, the maximum length of a post
- POST_INTERVAL_MIN: Number, the minimum interval between posts in seconds
- POST_INTERVAL_MAX: Number, the maximum interval between posts in seconds
- ACTION_INTERVAL: Number, the interval between actions in seconds

## Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Set environment variables
4. Run the client: `npm start`

## Architecture

The system follows a layered architecture:

1. **API Layer** (Bottom)
   - Raw API communication
   - Rate limiting
   - Authentication

2. **Client Layer**
   - Base functionality
   - State management
   - Caching

3. **Feature Layer**
   - Post management
   - Interactions
   - Search
   - Content generation

4. **Interface Layer** (Top)
   - Client interface
   - Runtime management
   - Configuration

## File Dependencies

```
index.ts
├── environment.ts
├── base.ts
│   └── api.ts
├── post.ts
│   ├── base.ts
│   └── utils.ts
├── interactions.ts
│   ├── base.ts
│   └── utils.ts
└── search.ts
    ├── base.ts
    └── utils.ts
```

- `api.ts` depends on `types.ts`
- `base.ts` depends on `types.ts`
- `post.ts` depends on `types.ts`
- `interactions.ts` depends on `types.ts`
- `search.ts` depends on `types.ts`
- `environment.ts` depends on `types.ts`
- `utils.ts` depends on `types.ts`
- `index.ts` depends on `types.ts`
- `environment.ts` depends on `types.ts`

## Safety Notes

1. Rate Limiting
   - Built-in rate limit management
   - Configurable intervals
   - Automatic backoff

2. Content Safety
   - Content filtering
   - Engagement limits
   - Conversation depth control

3. Error Handling
   - Comprehensive error catching
   - Logging
   - Graceful degradation

## Usage Warning

This client includes search and interaction capabilities that should be used responsibly.Be aware of:

1. Rate limit implications
2. User privacy considerations
3. Platform terms of service
4. Potential account restrictions

Always test with `TRUTHSOCIAL_DRY_RUN=true` before live deployment.
