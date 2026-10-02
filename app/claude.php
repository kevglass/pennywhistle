<?php
// The Claude request that turns sheet-music page images into ABC notation.
// Shared by the API (app/api.php) and offline tooling so both send the same request.
declare(strict_types=1);

use Anthropic\Client;

const TRANSCRIBE_PROMPT = <<<'TXT'
Transcribe the melody in these sheet-music page images into ABC notation (standard 2.1). The result will be turned into penny-whistle tablature, so the rhythm and pitches must match the printed music exactly.

What to transcribe:
- The melody only: the top line of the top staff. In piano/vocal or band scores, use the vocal or lead melody line (the one with lyrics, if any). Ignore accompaniment staves, bass lines, and harmony notes; if two notes sound together in the melody, write only the top one.
- Every page belongs to the same piece, in order. If the pages clearly hold several separate tunes, transcribe only the first.

How to write it:
- Header lines: X:1, T: (the title as printed), C: (composer, if printed), M:, L: (choose 1/8 for most folk/dance tunes, 1/4 for slower songs), Q: (only if a tempo is printed), then K: last. K: must match the printed key signature, with the mode (e.g. K:Em, K:Ador) when the music is clearly not major.
- Write pitches exactly as written (no transposing), including accidentals; the key signature applies as in ABC.
- Keep exact note lengths, dotted notes, ties (-), triplets ((3abc), rests (z), and pickup (anacrusis) bars. Write multi-bar rests out as one rest per bar.
- Bar lines as printed, including repeats (|: :|), first and second endings ([1 [2) and double/final bars. Do not expand repeats. Put D.C./D.S./Fine/Coda instructions in quoted annotations like "^D.C. al Fine".
- Chord symbols: if guitar chord symbols are printed above the staff, put each one in double quotes immediately before the note it sits over, e.g. "G"B2 "D7"A2. Do not invent chords that are not printed.
- Leave out grace notes, ornaments, slurs, dynamics, fingering numbers, and lyrics.
- About four bars per line of ABC.

If something is unclear, make the most musical best guess and list each uncertainty on a % comment line at the end.

Reply with the ABC notation only: no explanation and no code fences.
TXT;

const TRANSCRIBE_SYSTEM = 'You are an expert music engraver and transcriber who reads printed sheet music and writes precise ABC notation.';

/** Message content: each page image (labelled), then the instructions. */
function transcription_content(array $pages, string $hint = ''): array
{
    $pages = array_slice($pages, 0, 40);
    $content = [];
    foreach (array_values($pages) as $i => $p) {
        if (!in_array($p['mediaType'] ?? '', ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], true) || !is_string($p['data'] ?? null)) continue;
        $content[] = ['type' => 'text', 'text' => sprintf('Page %d of %d:', $i + 1, count($pages))];
        $content[] = ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => $p['mediaType'], 'data' => $p['data']]];
    }
    if (!$content) return [];
    $hint = trim($hint);
    $content[] = ['type' => 'text', 'text' => TRANSCRIBE_PROMPT . ($hint !== '' ? "\n\nNote from the user about this music: " . mb_substr($hint, 0, 1000) : '')];
    return $content;
}

/**
 * Start a streaming transcription request with settings each model accepts.
 * Opus/Sonnet 5.5: adaptive thinking, high effort, server-side refusal fallback.
 * Haiku 4.5: extended thinking with a token budget (no effort setting or fallback).
 */
function transcription_stream(Client $client, string $model, array $content, string $workspace = '')
{
    $common = [
        'maxTokens' => 32000,
        'messages' => [['role' => 'user', 'content' => $content]],
        'model' => $model,
        'system' => TRANSCRIBE_SYSTEM,
        'workspaceID' => $workspace !== '' ? $workspace : null,
    ];
    if (str_starts_with($model, 'claude-haiku-4-5')) {
        return $client->beta->messages->createStream(...$common, thinking: ['type' => 'enabled', 'budgetTokens' => 10000]);
    }
    return $client->beta->messages->createStream(
        ...$common,
        thinking: ['type' => 'adaptive'],
        outputConfig: ['effort' => 'high'],
        // Retry on Anthropic's recommended fallback model if a safety classifier declines.
        fallbacks: 'default',
        betas: ['server-side-fallback-2026-07-01'],
    );
}
