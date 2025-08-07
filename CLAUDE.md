# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
Next.js OpenAI Doc Search Starter - A ChatGPT-style documentation search powered by Next.js, OpenAI, and Supabase. This app processes MDX files to create vector embeddings for semantic search using OpenAI's text-embedding-ada-002 model and pgvector in Supabase.

## Development Commands

### Core Commands
- `pnpm dev` - Start development server
- `pnpm build` - Build production app (includes embedding generation)
- `pnpm start` - Start production server
- `pnpm lint` - Run ESLint
- `pnpm format` - Format code with Prettier

### Embedding Management
- `pnpm run embeddings` - Generate embeddings for all MDX files in pages/
- `pnpm run embeddings:refresh` - Force regenerate all embeddings (ignores checksums)

### Database Setup
- `supabase start` - Start local Supabase instance
- `supabase status` - Get database URLs and keys
- `supabase db push` - Apply migrations to hosted database
- `supabase link` - Link to hosted Supabase project

## Architecture

### Two-Phase Processing
1. **Build Time**: MDX files → processed sections → OpenAI embeddings → Supabase storage
2. **Runtime**: User query → embedding → vector similarity search → GPT response

### Key Components
- **lib/generate-embeddings.ts**: Processes MDX files, creates embeddings, stores in database
- **pages/api/vector-search.ts**: API endpoint for semantic search and GPT completion
- **components/SearchDialog.tsx**: Frontend search interface with streaming responses

### Database Schema
- `nods_page`: Pages with metadata and checksums
- `nods_page_section`: Page sections with embeddings (pgvector)
- Uses RPC function `match_page_sections` for similarity search

### Environment Variables Required
- `OPENAI_KEY`: OpenAI API key
- `NEXT_PUBLIC_SUPABASE_URL`: Supabase project URL  
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key

## Development Notes

### MDX Processing
- Only processes `.mdx` files in `pages/` directory
- Splits content by headings into searchable sections
- Uses checksums to avoid regenerating unchanged files
- Ignores files listed in `ignoredFiles` array

### Embedding Strategy
- Uses text-embedding-ada-002 model (1536 dimensions)
- Token limit of 1500 for context window
- Match threshold of 0.78 for similarity search
- Minimum content length of 50 characters

### Component Structure
- UI components in `components/ui/` using Radix UI primitives
- Uses Tailwind CSS for styling
- Search dialog supports keyboard shortcuts (⌘K)