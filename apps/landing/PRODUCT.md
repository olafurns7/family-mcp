# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

The user requested Astro + TypeScript or TanStack Start and a static build.
Astro + TypeScript was selected for this small static landing page. Deployment is
to the user's Cloudflare account at mcp.olinn.is.

## Users

People exploring and installing the MCP servers in the family-mcp repository.
English and Icelandic readers are equally supported, as requested by the user.

## Product Purpose

Introduce the four MCP servers briefly, explain what each makes available, and
provide accurate install commands plus links to GitHub and setup documentation.
Success is finding the relevant server and copying its install command quickly.

## Positioning

One small collection of unofficial local MCP servers for everyday services in
Iceland: Abler, InfoMentor, Krónan, and Domino’s Iceland.

## Operating Context

Users install a standalone native executable, authenticate locally, and connect
it to their MCP client. macOS and glibc Linux on arm64 and x64 are supported.
The landing page itself does not log in, access accounts, or run an MCP server.

## Capabilities and Constraints

- Brief introduction, four server descriptions, copyable install commands, and
  links to the repository and per-package setup instructions.
- Both English and Icelandic, with a visible language switch.
- Use the published package versions and their pinned installer URLs.
- Abler provides sports schedules; InfoMentor provides school information;
  Krónan provides grocery account reads, not grocery ordering.
- Domino’s is a preview: charging is untested and 3-D Secure continuation is
  not implemented. Preserve this distinction in both languages.
- Credentials stay on the user's machine; returned account data is shared with
  the configured MCP host. Do not claim all data stays local.
- No invented adoption, testimonials, partnerships, or performance claims.

## Evidence on Hand

Repository README, package READMEs, package manifests, and GitHub releases.
Published versions verified on 2026-09-17: Abler 0.5.2, InfoMentor 0.6.1,
Krónan 0.1.0, and Domino’s 0.1.0 preview.

## Product Principles

- Keep the introduction and path to installation short.
- Write Icelandic directly and idiomatically; avoid literal translations of English marketing copy.
- Keep platform, architecture and runtime details in setup documentation, not on the landing page.
- Make capabilities and preview limitations accurate in both languages.
- Link detailed setup instructions instead of duplicating full documentation.
- Use semantic, responsive HTML with keyboard-accessible controls.
