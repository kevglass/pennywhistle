<?php
// Looks up who owns the rights to a tune and whether it can be used for free in a game or
// video, using Claude with web search. The result is stored as the tune's "license" field.
declare(strict_types=1);

use Anthropic\Client;

const LICENSE_STATUSES = ['free', 'attribution', 'restricted', 'unknown'];
const COPYRIGHT_STATES = ['active', 'expired', 'traditional', 'unknown'];

const LICENSE_SYSTEM = 'You are a careful music-rights researcher. You find out who wrote a piece of music, whether it is still under copyright, and how it is licensed, using reliable sources (publishers, collecting societies such as PRS/ASCAP/BMI, The Session, IMSLP, Wikipedia, the composer\'s own site). You never guess that something is public domain without evidence.';

const LICENSE_PROMPT = <<<'TXT'
Find out the copyright and license status of this piece of music, and whether someone could use it for free in a video game or a video (for example on YouTube) by playing or recording the melody themselves.

Always search the web before answering, even for tunes you know, and base the answer on what you find, not on memory. Research the composition (the melody), not any particular recording. Things to check:
- Who wrote it and when. Traditional and folk tunes with no known composer, or composers who died more than 70 years ago, are normally public domain.
- If a living or recent composer or band wrote it (or it is a modern tune often mistaken for a traditional one), it is under copyright: say who holds it and whether they offer it under a free license such as Creative Commons.
- Whether the title is shared by different tunes. Use the notes given to tell them apart.
- When the copyright runs out. In the UK and EU it lasts until the end of the 70th year after the composer's death (after the last surviving co-writer's death for joint works). In the US, works published before 1930 are public domain and later ones generally last 95 years from publication or life + 70 years. Give the year it expired or will expire, and how you worked it out.

Choose the copyright state:
- "active": still under copyright.
- "expired": had a known author whose copyright has run out.
- "traditional": no known author (folk tradition), so never owned by anyone.
- "unknown": you could not establish it.

Choose the status:
- "free": public domain or a license (e.g. CC0) that allows use in games and videos, commercial included, with no conditions.
- "attribution": free to use in games and videos, but with conditions such as crediting the composer (e.g. CC BY, CC BY-SA). Put the conditions in "conditions".
- "restricted": under copyright with no free license, or a license that rules out commercial use (e.g. CC BY-NC). Using it needs permission or a paid license.
- "unknown": you could not establish the facts with reasonable confidence.

Write "summary" as one or two plain sentences for a musician, e.g. "Traditional Irish reel, public domain: free to use in games and videos." Mention in "notes" anything else worth knowing, such as a modern arrangement having its own copyright. List the pages you relied on in "sources", saying for each what it told you (e.g. "Credits the tune to Jay Ungar, 1982").
TXT;

/** JSON schema of the answer (structured output). */
function license_schema(): array
{
    return [
        'type' => 'object',
        'properties' => [
            'status' => ['type' => 'string', 'enum' => LICENSE_STATUSES],
            'license' => ['type' => 'string', 'description' => 'Short license name, e.g. "Public domain", "CC BY 4.0", "Copyright (all rights reserved)"'],
            'composer' => ['type' => 'string', 'description' => 'Who wrote it, e.g. "Traditional (Irish)" or "Carreg Lafar (2001)"; empty if unknown'],
            'rightsHolder' => ['type' => 'string', 'description' => 'Who holds the rights now (composer, estate or publisher), if under copyright; otherwise empty'],
            'copyright' => ['type' => 'string', 'enum' => COPYRIGHT_STATES],
            'written' => ['type' => 'string', 'description' => 'When it was composed or first published, e.g. "1982", "c. 1691", "19th century"; empty if unknown'],
            'composerDied' => ['type' => 'string', 'description' => 'Year the composer (or last surviving co-writer) died; empty if living, traditional or unknown'],
            'copyrightExpires' => ['type' => 'string', 'description' => 'Year the copyright expired or will expire, e.g. "1808" or "2074"; empty if traditional or unknown'],
            'copyrightBasis' => ['type' => 'string', 'description' => 'One sentence on how the expiry was worked out, e.g. "Composer died 1738; UK/EU copyright lasts life + 70 years."'],
            'summary' => ['type' => 'string'],
            'conditions' => ['type' => 'string', 'description' => 'What a game or video must do to use it (e.g. credit line); empty if none'],
            'notes' => ['type' => 'string'],
            'confidence' => ['type' => 'string', 'enum' => ['high', 'medium', 'low']],
            'sources' => [
                'type' => 'array',
                'items' => [
                    'type' => 'object',
                    'properties' => ['title' => ['type' => 'string'], 'url' => ['type' => 'string'], 'supports' => ['type' => 'string', 'description' => 'What this page told you']],
                    'required' => ['title', 'url', 'supports'],
                    'additionalProperties' => false,
                ],
            ],
        ],
        'required' => ['status', 'license', 'composer', 'rightsHolder', 'copyright', 'written', 'composerDied', 'copyrightExpires', 'copyrightBasis', 'summary', 'conditions', 'notes', 'confidence', 'sources'],
        'additionalProperties' => false,
    ];
}

/** What we know about the tune: title, composer and the opening notes to tell same-named tunes apart. */
function license_question(array $tune): string
{
    $abc = (string) ($tune['abc'] ?? '');
    $head = [];
    $body = [];
    foreach (preg_split('/\R/', $abc) ?: [] as $line) {
        if (preg_match('/^[A-Za-z]:/', $line) === 1 && !$body) $head[] = $line;
        elseif (trim($line) !== '' && !str_starts_with($line, '%')) $body[] = $line;
    }
    $lines = ['Title: ' . ($tune['title'] ?? 'Untitled')];
    if (!empty($tune['composer'])) $lines[] = 'Composer (as printed on the sheet music): ' . $tune['composer'];
    $lines[] = "Opening of the melody in ABC notation:\n" . implode("\n", array_merge($head, array_slice($body, 0, 4)));
    return implode("\n", $lines) . "\n\n" . LICENSE_PROMPT;
}

/**
 * Research a tune's license. Returns the stored record: the schema fields plus checkedAt and model.
 * Sonnet 5.5 at low effort matched Opus 5.5's verdicts on tricky tunes (modern tunes sold as
 * "trad", public-domain melodies inside copyrighted songs) at a fraction of the cost; Haiku 4.5
 * called a copyrighted tune free, mistaking a recording's license for the composition's.
 * Web search may pause a long turn (stop reason pause_turn); the turn is then resumed as is.
 */
function check_license(Client $client, string $model, string $effort, array $tune, string $workspace = ''): array
{
    $messages = [['role' => 'user', 'content' => license_question($tune)]];
    for ($turn = 0; $turn < 4; $turn++) {
        $message = $client->beta->messages->create(
            model: $model,
            maxTokens: 16000,
            system: LICENSE_SYSTEM,
            messages: $messages,
            tools: [['type' => 'web_search_20260209', 'name' => 'web_search', 'maxUses' => 8]],
            thinking: ['type' => 'adaptive'],
            outputConfig: ['effort' => $effort, 'format' => ['type' => 'json_schema', 'schema' => license_schema()]],
            workspaceID: $workspace !== '' ? $workspace : null,
            // Retry on Anthropic's recommended fallback model if a safety classifier declines.
            fallbacks: 'default',
            betas: ['server-side-fallback-2026-07-01'],
        );
        if ($message->stopReason !== 'pause_turn') break;
        $messages[] = ['role' => 'assistant', 'content' => $message->content];
    }
    if ($message->stopReason === 'refusal') throw new RuntimeException('Claude declined to research this tune.');
    // The JSON answer is the text after the last search; earlier text is commentary between searches.
    $text = '';
    foreach ($message->content as $block) $text = $block->type === 'text' ? $text . $block->text : '';
    $data = json_decode($text, true);
    if (!is_array($data) || !in_array($data['status'] ?? null, LICENSE_STATUSES, true)) {
        throw new RuntimeException($message->stopReason === 'max_tokens' ? 'The answer was cut short.' : 'Claude did not return a usable answer.');
    }
    $str = fn (string $k, int $max = 1000) => mb_substr(trim((string) ($data[$k] ?? '')), 0, $max);
    $sources = [];
    foreach (array_slice(is_array($data['sources'] ?? null) ? $data['sources'] : [], 0, 10) as $s) {
        $url = (string) ($s['url'] ?? '');
        if (preg_match('#^https?://#i', $url) === 1) $sources[] = ['title' => mb_substr((string) ($s['title'] ?? $url), 0, 200), 'url' => mb_substr($url, 0, 1000), 'supports' => mb_substr((string) ($s['supports'] ?? ''), 0, 500)];
    }
    return [
        'status' => $data['status'],
        'license' => $str('license', 200),
        'composer' => $str('composer', 200),
        'rightsHolder' => $str('rightsHolder', 200),
        'copyright' => in_array($data['copyright'] ?? '', COPYRIGHT_STATES, true) ? $data['copyright'] : 'unknown',
        'written' => $str('written', 100),
        'composerDied' => $str('composerDied', 100),
        'copyrightExpires' => $str('copyrightExpires', 100),
        'copyrightBasis' => $str('copyrightBasis', 500),
        'summary' => $str('summary'),
        'conditions' => $str('conditions'),
        'notes' => $str('notes', 2000),
        'confidence' => in_array($data['confidence'] ?? '', ['high', 'medium', 'low'], true) ? $data['confidence'] : 'low',
        'sources' => $sources,
        'checkedAt' => gmdate('Y-m-d\TH:i:s\Z'),
        'model' => $message->model ?: $model,
    ];
}
