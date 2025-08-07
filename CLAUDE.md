# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Korean Legal Consultation AI Assistant - A ChatGPT-style legal consultation service powered by Next.js, OpenAI, and Supabase. This app processes Korean legal documents (MDX files) to create vector embeddings for semantic search using OpenAI's text-embedding-ada-002 model and pgvector in Supabase. Users can ask legal questions in Korean and get AI-powered responses based on legal documentation.

## Development Commands

### Core Commands

- `pnpm dev` - Start development server
- `pnpm build` - Build production app (includes embedding generation)
- `pnpm start` - Start production server
- `pnpm lint` - Run ESLint
- `pnpm format` - Format code with Prettier
- `npx tsc --noEmit` - Run TypeScript type checking (no test scripts available)

### Embedding Management

- `pnpm run embeddings` - Generate embeddings for all Korean legal MDX files in pages/docs/
- `pnpm run embeddings:refresh` - Force regenerate all embeddings (ignores checksums)

### Database Setup

- `supabase start` - Start local Supabase instance
- `supabase status` - Get database URLs and keys
- `supabase db push` - Apply migrations to hosted database
- `supabase link` - Link to hosted Supabase project

## Architecture

### Two-Phase Processing

1. **Build Time**: Korean legal MDX files → processed sections → OpenAI embeddings → Supabase storage
2. **Runtime**: Korean user query → embedding → vector similarity search → Korean GPT response with citations

### Key Components

- **lib/generate-embeddings.ts**: Processes Korean legal MDX files, creates embeddings, stores in database
- **pages/api/vector-search.ts**: API endpoint for semantic search and Korean GPT completion with logging
- **components/SearchDialog.tsx**: Korean legal consultation interface with streaming responses and citation sources
- **pages/docs/**: Directory containing Korean legal documents (민법총칙.mdx, etc.)

### Database Schema

- `nods_page`: Pages with metadata and checksums
- `nods_page_section`: Page sections with embeddings (pgvector)
- Uses RPC function `match_page_sections` for similarity search

### Environment Variables Required

- `OPENAI_KEY`: OpenAI API key
- `NEXT_PUBLIC_SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key

## Development Notes

### Local Development Setup

1. Copy environment template: `cp .env.example .env`
2. Set required environment variables in `.env`
3. Start Supabase: `supabase start`
4. Get keys: `supabase status`
5. Generate embeddings: `pnpm run embeddings`
6. Start dev server: `pnpm dev`

### Korean Legal Document Processing

- Only processes `.mdx` files in `pages/docs/` directory
- Supports Korean legal documents (민법총칙.mdx, etc.)
- Splits content by headings into searchable sections
- Uses checksums to avoid regenerating unchanged files
- Ignores files listed in `ignoredFiles` array in lib/generate-embeddings.ts

### Embedding Strategy

- Uses text-embedding-ada-002 model (1536 dimensions)
- Token limit of 1500 for context window
- Match threshold of 0.78 for similarity search
- Minimum content length of 50 characters

### UI Features

- Korean language interface with legal consultation focus
- Quick question templates for common legal queries
- Citation sources with expandable content display
- Chat-style conversation history
- UI components in `components/ui/` using Radix UI primitives
- Uses Tailwind CSS for styling
- Search dialog supports keyboard shortcuts (⌘K)
