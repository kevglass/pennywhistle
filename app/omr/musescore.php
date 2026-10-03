<?php
// Reads the melody from a PDF exported by MuseScore 4 and writes it as ABC notation, without AI.
//
// MuseScore draws every musical symbol as a glyph of its SMuFL music font (Leland) at an exact
// position, and staff lines, stems and barlines as plain lines and beams as filled shapes. So
// instead of recognising pixels we read those drawing commands back (app/omr/content.php) and
// rebuild the music from the geometry: a notehead's height on the staff gives its pitch, its
// shape plus the flags/beams on its stem give its length, and so on.
//
// musescore_to_abc() returns null when the PDF isn't a MuseScore 4 export, or when the result
// doesn't add up (bars that don't fill the time signature), so the caller can fall back to Claude.
declare(strict_types=1);

require_once __DIR__ . '/content.php';

/** True when the PDF looks like a MuseScore 4 export (its music font is Leland). */
function musescore_detect(PdfDoc $doc): bool
{
    if (str_contains($doc->info['Creator'] ?? '', 'MuseScore')) return true;
    foreach (array_slice($doc->pages(), 0, 2) as $page) {
        $res = (array) $doc->get($page['Resources'] ?? []);
        foreach ((array) $doc->get($res['Font'] ?? []) as $f) {
            $f = $doc->get($f);
            if (is_array($f) && str_contains((string) $doc->name($f['BaseFont'] ?? null), 'Leland')) return true;
        }
    }
    return false;
}

/**
 * @return array{abc: string, warnings: list<string>, bars: int, notes: int}|null
 */
function musescore_to_abc(string $pdfData, string $fallbackTitle = ''): ?array
{
    // Cheap check before parsing: the font name or creator is visible unless the PDF
    // keeps its objects in compressed object streams.
    if (!str_contains($pdfData, 'Leland') && !str_contains($pdfData, 'MuseScore') && !str_contains($pdfData, 'ObjStm')) return null;
    try {
        $doc = new PdfDoc($pdfData);
    } catch (Throwable) {
        return null;
    }
    if (!musescore_detect($doc)) return null;
    $reader = new MuseScoreReader();
    foreach ($doc->pages() as $page) $reader->addPage(PdfContent::page($doc, $page));
    return $reader->result($fallbackTitle);
}

final class MuseScoreReader
{
    // SMuFL code points
    private const HEADS = [0xE0A0 => 8, 0xE0A2 => 4, 0xE0A3 => 2, 0xE0A4 => 1, 0xE0A9 => 1, 0xE0FA => 4, 0xE0FB => 2, 0xE0FC => 1];
    private const RESTS = [0xE4E2 => 8, 0xE4E3 => 4, 0xE4E4 => 2, 0xE4E5 => 1, 0xE4E6 => 0.5, 0xE4E7 => 0.25, 0xE4E8 => 0.125, 0xE4E9 => 0.0625];
    private const FLAGS = [0xE240 => 1, 0xE241 => 1, 0xE242 => 2, 0xE243 => 2, 0xE244 => 3, 0xE245 => 3, 0xE246 => 4, 0xE247 => 4];
    private const ACCIDENTALS = [0xE260 => '_', 0xE261 => '=', 0xE262 => '^', 0xE263 => '^^', 0xE264 => '__'];
    private const CLEFS = [0xE050 => 'treble', 0xE052 => 'treble', 0xE053 => 'treble', 0xE054 => 'treble', 0xE055 => 'treble', 0xE062 => 'bass', 0xE064 => 'bass', 0xE065 => 'bass', 0xE05C => 'alto'];
    private const DOT = 0xE1E7;
    private const REPEAT_DOT = 0xE044;
    private const SEGNO = 0xE047;
    private const CODA = 0xE048;

    private array $systems = []; // melody staff of each system, in reading order
    private array $headerText = []; // text above the first staff of the first page
    private ?array $tempo = null;
    private array $warnings = [];
    private array $longLines = []; // y of long horizontal lines on the current page

    public function addPage(PdfContent $page): void
    {
        $glyphs = [];
        $text = [];
        foreach ($page->glyphs as $g) {
            if (str_starts_with($g['font'], 'Leland') || str_starts_with($g['font'], 'Bravura')) {
                $cp = $g['ch'] === '' ? 0 : mb_ord($g['ch']);
                if ($cp) $glyphs[] = $g + ['cp' => $cp];
            } else {
                $text[] = $g;
            }
        }
        $staves = $this->findStaves($page->strokes);
        if (!$staves) return;
        $verticals = [];
        foreach ($page->strokes as $s) {
            if (count($s['pts']) !== 2 || $s['curve']) continue;
            [[$x0, $y0], [$x1, $y1]] = $s['pts'];
            if (abs($x0 - $x1) < 0.05 && abs($y1 - $y0) > 0.5) $verticals[] = ['x' => $x0, 'y0' => min($y0, $y1), 'y1' => max($y0, $y1), 'w' => $s['width']];
        }

        // Group staves into systems: a vertical line at the left end joining two staves.
        $systems = [];
        foreach ($staves as $i => $st) {
            $joined = false;
            if ($i > 0 && $systems) {
                $prev = end($systems)[count(end($systems)) - 1];
                foreach ($verticals as $v) {
                    if (abs($v['x'] - $st['x0']) < 2 * $st['sp'] && $v['y0'] <= $prev['bottom'] + 0.5 && $v['y1'] >= $st['top'] - 0.5) { $joined = true; break; }
                }
            }
            if ($joined) $systems[count($systems) - 1][] = $st;
            else $systems[] = [$st];
        }

        // Words of text, for titles, chord symbols, voltas and directions.
        $words = self::words($text);
        $firstTop = $staves[0]['top'];
        if (!$this->systems) {
            foreach ($words as $w) if ($w['y'] < $firstTop - 4 * $staves[0]['sp'] && preg_match('/\pL/u', $w['text'])) $this->headerText[] = $w;
        }

        // Big text above a staff after the first tune: the title of the next tune in a set.
        $titles = array_values(array_filter($words, fn ($w) => $w['size'] >= 17 && preg_match('/\pL/u', $w['text']) && !self::isChord($w['text']) && empty($w['lyric'])));
        $prevBottom = -INF;

        foreach ($systems as $si => $sys) {
            $staff = null;
            foreach ($sys as $st) {
                if ($this->clefOf($st, $glyphs) !== null) { $staff = $st; break; }
            }
            if ($staff === null) continue;
            // This staff's vertical zone: halfway to the neighbouring staves (or a generous margin).
            $idx = array_search($staff, $staves, true);
            $above = $idx > 0 ? $staves[$idx - 1]['bottom'] : -INF;
            $below = isset($staves[$idx + 1]) ? $staves[$idx + 1]['top'] : INF;
            $zoneTop = max(($above + $staff['top']) / 2, $staff['top'] - 12 * $staff['sp']);
            $zoneBottom = min(($below + $staff['bottom']) / 2, $staff['bottom'] + 12 * $staff['sp']);
            // Other long horizontal lines (e.g. a tablature staff) also bound the zone.
            foreach ($this->longLines as $ly) {
                if ($ly < $staff['top'] - 0.5) $zoneTop = max($zoneTop, $ly + 0.3 * $staff['sp']);
                if ($ly > $staff['bottom'] + 0.5) $zoneBottom = min($zoneBottom, $ly - 0.3 * $staff['sp']);
            }
            $staff['zone'] = [$zoneTop, $zoneBottom];
            $staff['glyphs'] = array_values(array_filter($glyphs, fn ($g) => $g['y'] >= $zoneTop && $g['y'] <= $zoneBottom && $g['x'] >= $staff['x0'] - 2 * $staff['sp'] && $g['x'] <= $staff['x1'] + $staff['sp']));
            $staff['verticals'] = array_values(array_filter($verticals, fn ($v) => $v['y1'] >= $zoneTop && $v['y0'] <= $zoneBottom && $v['x'] >= $staff['x0'] - $staff['sp'] && $v['x'] <= $staff['x1'] + $staff['sp']));
            // (Beams can hang below the zone into the gap before another staff; they are only
            // matched to this staff's stem tips, so a wider band is safe.)
            $staff['fills'] = array_values(array_filter($page->fills, function ($f) use ($staff) {
                $ys = array_column($f['pts'], 1);
                $xs = array_column($f['pts'], 0);
                return min($ys) >= $staff['top'] - 10 * $staff['sp'] && max($ys) <= $staff['bottom'] + 10 * $staff['sp'] && max($xs) - min($xs) < $staff['x1'] - $staff['x0'];
            }));
            $staff['curves'] = array_values(array_filter(array_merge($page->fills, $page->strokes), function ($f) use ($zoneTop, $zoneBottom) {
                if (!$f['curve']) return false;
                $ys = array_column($f['pts'], 1);
                return min($ys) >= $zoneTop && max($ys) <= $zoneBottom;
            }));
            if ($this->systems) {
                $t = array_filter($titles, fn ($w) => $w['y'] < $staff['top'] && $w['y'] > $prevBottom);
                usort($t, fn ($a, $b) => [$a['y'], $a['x']] <=> [$b['y'], $b['x']]);
                if ($t) $staff['title'] = trim(implode(' ', array_column($t, 'text')));
            }
            $prevBottom = $sys[count($sys) - 1]['bottom'];
            // Text: anything in the zone, plus chord symbols and ending numbers from the whole gap
            // above the staff (MuseScore always puts them above; lyrics go below).
            $gapTop = max($above, $staff['top'] - 10 * $staff['sp']);
            foreach ($this->longLines as $ly) if ($ly < $staff['top'] - 0.5) $gapTop = max($gapTop, $ly);
            $staff['words'] = array_values(array_filter($words, fn ($w) => ($w['y'] >= $zoneTop && $w['y'] <= $zoneBottom)
                || ($w['y'] < $zoneTop && $w['y'] > $gapTop + 0.5 * $staff['sp'] && empty($w['lyric']) && (self::isChord($w['text']) || preg_match('/^(\d\.\s*,?\s*)+$/', $w['text'])))));
            $this->systems[] = $staff;
        }
    }

    /** Sets of five evenly spaced horizontal lines. */
    private function findStaves(array $strokes): array
    {
        $lines = [];
        foreach ($strokes as $s) {
            if ($s['curve'] || count($s['pts']) !== 2 || $s['width'] > 1.5) continue;
            [[$x0, $y0], [$x1, $y1]] = $s['pts'];
            if (abs($y0 - $y1) > 0.05 || abs($x1 - $x0) < 10) continue;
            $lines[] = ['y' => $y0, 'x0' => min($x0, $x1), 'x1' => max($x0, $x1)];
        }
        // merge segments on the same y that touch or overlap
        usort($lines, fn ($a, $b) => [$a['y'], $a['x0']] <=> [$b['y'], $b['x0']]);
        $merged = [];
        foreach ($lines as $l) {
            $last = $merged ? $merged[count($merged) - 1] : null;
            if ($last && abs($last['y'] - $l['y']) < 0.1 && $l['x0'] <= $last['x1'] + 2) {
                $merged[count($merged) - 1]['x1'] = max($last['x1'], $l['x1']);
            } else {
                $merged[] = $l;
            }
        }
        // Lines of any staff, including ones that aren't notation (tablature): four or more
        // long lines, evenly spaced. (A lone long line is a volta bracket or similar.)
        $this->longLines = [];
        $long = array_values(array_filter($merged, fn ($l) => $l['x1'] - $l['x0'] > 60));
        for ($i = 0; $i < count($long);) {
            $j = $i;
            while (isset($long[$j + 1]) && $long[$j + 1]['y'] - $long[$j]['y'] < 20 && abs($long[$j + 1]['x0'] - $long[$i]['x0']) < 3) $j++;
            if ($j - $i >= 3) for ($k = $i; $k <= $j; $k++) $this->longLines[] = $long[$k]['y'];
            $i = $j + 1;
        }
        $staves = [];
        $used = [];
        $n = count($merged);
        for ($i = 0; $i < $n; $i++) {
            if (isset($used[$i])) continue;
            $group = [$i];
            for ($j = $i + 1; $j < $n && count($group) < 5; $j++) {
                if (isset($used[$j])) continue;
                $a = $merged[$group[count($group) - 1]];
                $b = $merged[$j];
                if (abs($b['x0'] - $merged[$i]['x0']) > 3 || abs($b['x1'] - $merged[$i]['x1']) > 3) continue;
                $gap = $b['y'] - $a['y'];
                if (count($group) === 1) {
                    if ($gap > 2 && $gap < 20) $group[] = $j;
                    elseif ($gap >= 20) break;
                } else {
                    $sp = $merged[$group[1]]['y'] - $merged[$group[0]]['y'];
                    if (abs($gap - $sp) < 0.3) $group[] = $j;
                    elseif ($gap > $sp + 0.3) break;
                }
            }
            if (count($group) !== 5) continue;
            // A sixth line at the same spacing means a tablature staff, not notation.
            $sp = ($merged[$group[4]]['y'] - $merged[$group[0]]['y']) / 4;
            $next = $group[4] + 1;
            if (isset($merged[$next]) && abs($merged[$next]['y'] - $merged[$group[4]]['y'] - $sp) < 0.3 && abs($merged[$next]['x0'] - $merged[$i]['x0']) < 3) continue;
            foreach ($group as $g) $used[$g] = true;
            $staves[] = ['top' => $merged[$group[0]]['y'], 'bottom' => $merged[$group[4]]['y'], 'sp' => $sp, 'x0' => $merged[$i]['x0'], 'x1' => $merged[$i]['x1']];
        }
        usort($staves, fn ($a, $b) => $a['top'] <=> $b['top']);
        return $staves;
    }

    private function clefOf(array $staff, array $glyphs): ?string
    {
        foreach ($glyphs as $g) {
            if (isset(self::CLEFS[$g['cp']]) && $g['y'] >= $staff['top'] - $staff['sp'] && $g['y'] <= $staff['bottom'] + $staff['sp'] && $g['x'] < $staff['x0'] + 6 * $staff['sp'] && $g['x'] >= $staff['x0'] - $staff['sp']) {
                return self::CLEFS[$g['cp']];
            }
        }
        return null;
    }

    /** Group text glyphs into words: one per text object, split where the baseline changes. */
    private static function words(array $text): array
    {
        usort($text, fn ($a, $b) => [round($a['y'] / 4), $a['run'], $a['x']] <=> [round($b['y'] / 4), $b['run'], $b['x']]);
        $words = [];
        foreach ($text as $g) {
            $ch = preg_match('/^\s$/u', $g['ch']) ? ' ' : $g['ch'];
            $last = $words ? $words[count($words) - 1] : null;
            // (superscripts such as the 7 in A7 sit a little higher but belong to the same text)
            $sameRun = $last && $last['run'] === $g['run'] && abs($last['y'] - $g['y']) < $g['size'] * 0.6 && $g['x'] - $last['x1'] < $g['size'] * 1.5;
            // (and a separate text object that touches the previous one, e.g. MuseScore's chord extensions)
            $touching = $last && $last['run'] !== $g['run'] && abs($last['y'] - $g['y']) < $g['size'] * 0.6 && abs($g['x'] - $last['x1']) < $g['size'] * 0.15;
            if (($sameRun || $touching) && $g['x'] > $last['x'] - 0.1) {
                $words[count($words) - 1]['text'] .= $ch;
                $words[count($words) - 1]['x1'] = $g['x'] + $g['w'];
                $words[count($words) - 1]['fonts'][$g['font']] = true;
            } elseif ($ch !== ' ') {
                $words[] = ['text' => $ch, 'x' => $g['x'], 'x1' => $g['x'] + $g['w'], 'y' => $g['y'], 'size' => $g['size'], 'run' => $g['run'], 'fonts' => [$g['font'] => true]];
            }
        }
        foreach ($words as &$w) $w['text'] = trim(strtr($w['text'], ['ﬀ' => 'ff', 'ﬁ' => 'fi', 'ﬂ' => 'fl', 'ﬃ' => 'ffi', 'ﬄ' => 'ffl', '’' => "'"]));
        unset($w);
        // Lyric lines: rows of several words that are mostly not chord symbols.
        $rows = [];
        foreach ($words as $i => $w) $rows[(string) round($w['y'])][] = $i;
        foreach ($rows as $idx) {
            if (count($idx) < 3) continue;
            $chords = count(array_filter($idx, fn ($i) => self::isChord($words[$i]['text'])));
            if ($chords < count($idx) / 2) foreach ($idx as $i) $words[$i]['lyric'] = true;
        }
        return $words;
    }

    // ------------------------------------------------------------------ one system

    /** Read one staff into a list of events (clef, key, time, bar, note, rest, ...), sorted by x. */
    private function readStaff(array $st): array
    {
        $sp = $st['sp'];
        $events = [];
        $glyphs = $st['glyphs'];
        // Normal-size noteheads (grace notes are drawn smaller; leave them out).
        $headSizes = [];
        foreach ($glyphs as $g) if (isset(self::HEADS[$g['cp']])) $headSizes[] = round($g['size'], 1);
        $normal = $headSizes ? max($headSizes) : 4 * $sp;
        $pos = fn (float $y) => (int) round(($st['bottom'] - $y) / ($sp / 2)); // 0 = bottom line, 8 = top line

        $heads = [];
        $used = [];
        foreach ($glyphs as $i => $g) {
            if (!isset(self::HEADS[$g['cp']])) continue;
            if ($g['size'] < $normal * 0.85) continue; // grace / cue
            $heads[] = ['i' => $i, 'x' => $g['x'], 'x1' => $g['x'] + $g['w'], 'y' => $g['y'], 'pos' => $pos($g['y']), 'value' => self::HEADS[$g['cp']], 'acc' => '', 'dots' => 0];
        }

        // Stems: vertical lines starting at a notehead's edge.
        $stems = [];
        foreach ($st['verticals'] as $v) {
            if ($v['w'] > 0.16 * $sp) continue; // barlines are a bit thicker; thick ones much thicker
            $stems[] = $v;
        }
        $chords = []; // noteheads sharing a stem (or a whole note on its own)
        foreach ($heads as $h) {
            $best = null;
            $bestD = INF;
            if ($h['value'] < 4) {
                foreach ($stems as $si => $s) {
                    $dx = min(abs($s['x'] - $h['x']), abs($s['x'] - $h['x1']));
                    if ($dx > 0.35 * $sp) continue;
                    if ($h['y'] < $s['y0'] - 0.7 * $sp || $h['y'] > $s['y1'] + 0.7 * $sp) continue;
                    $endD = min(abs($h['y'] - $s['y0']), abs($h['y'] - $s['y1']));
                    if ($endD + $dx < $bestD) { $bestD = $endD + $dx; $best = $si; }
                }
            }
            $key = $best === null ? 'h' . $h['i'] : 's' . $best;
            $chords[$key] ??= ['heads' => [], 'stem' => $best === null ? null : $stems[$best]];
            $chords[$key]['heads'][] = $h;
        }
        // Barlines are vertical lines spanning the staff that are not stems.
        $stemXs = [];
        foreach ($chords as $c) if ($c['stem']) $stemXs[] = $c['stem']['x'];
        $bars = [];
        foreach ($st['verticals'] as $v) {
            if ($v['y0'] > $st['top'] + 0.3 * $sp || $v['y1'] < $st['bottom'] - 0.3 * $sp) continue;
            $isStem = false;
            foreach ($stemXs as $sx) if (abs($sx - $v['x']) < 0.01) { $isStem = true; break; }
            if ($isStem) continue;
            if ($v['x'] < $st['x0'] + 0.5 * $sp && $v['y1'] - $v['y0'] > ($st['bottom'] - $st['top']) * 1.5) continue; // system bracket line
            $bars[] = ['x' => $v['x'], 'thick' => $v['w'] > 0.25 * $sp];
        }
        usort($bars, fn ($a, $b) => $a['x'] <=> $b['x']);
        // Cluster lines of one barline (e.g. thin + thick)
        $barGroups = [];
        foreach ($bars as $b) {
            $last = $barGroups ? $barGroups[count($barGroups) - 1] : null;
            if ($last && $b['x'] - $last['x1'] < 1.2 * $sp) {
                $barGroups[count($barGroups) - 1]['lines'][] = $b;
                $barGroups[count($barGroups) - 1]['x1'] = $b['x'];
            } else {
                $barGroups[] = ['x' => $b['x'], 'x1' => $b['x'], 'lines' => [$b]];
            }
        }
        $repeatDots = array_values(array_filter($glyphs, fn ($g) => $g['cp'] === self::REPEAT_DOT));
        foreach ($barGroups as $bg) {
            $left = $right = false;
            foreach ($repeatDots as $d) {
                if ($d['x'] < $bg['x'] && $bg['x'] - $d['x'] < 1.5 * $sp) $left = true;
                if ($d['x'] > $bg['x1'] && $d['x'] - $bg['x1'] < 1.5 * $sp) $right = true;
            }
            $thick = array_map(fn ($l) => $l['thick'], $bg['lines']);
            $n = count($thick);
            $sym = match (true) {
                $n === 1 => '|',
                $n >= 2 && !$thick[0] && $thick[$n - 1] => '|]',
                $n >= 2 && $thick[0] && !$thick[$n - 1] => '[|',
                default => '||',
            };
            if ($left && $right) $sym = '::';
            elseif ($left) $sym = ':|';
            elseif ($right) $sym = '|:';
            $events[] = ['t' => 'bar', 'x' => $bg['x'], 'sym' => $sym, 'atStart' => $bg['x'] < $st['x0'] + 0.5 * $sp];
        }

        // Accidentals: attached to the notehead just right of them, or else part of a key signature.
        $keyAcc = [];
        foreach ($glyphs as $g) {
            if (!isset(self::ACCIDENTALS[$g['cp']]) || $g['size'] < $normal * 0.85) continue;
            $p = $pos($g['y']);
            $target = null;
            foreach ($chords as $k => $c) {
                foreach ($c['heads'] as $j => $h) {
                    // accidentals sit just left of their notehead; key signatures leave a wider gap
                    if ($h['pos'] === $p && $h['x'] > $g['x'] && $h['x'] - ($g['x'] + $g['w']) < 1.2 * $sp) {
                        if ($target === null || $h['x'] < $chords[$target[0]]['heads'][$target[1]]['x']) $target = [$k, $j];
                    }
                }
            }
            if ($target !== null) {
                // Is another accidental closer to that head? (several accidentals in a chord) - keep the nearest
                $chords[$target[0]]['heads'][$target[1]]['acc'] = self::ACCIDENTALS[$g['cp']];
            } else {
                $keyAcc[] = $g;
            }
        }
        // Key signatures: runs of accidentals with no notehead (at the start of a line or after a barline).
        usort($keyAcc, fn ($a, $b) => $a['x'] <=> $b['x']);
        $runs = [];
        foreach ($keyAcc as $g) {
            $last = $runs ? $runs[count($runs) - 1] : null;
            if ($last && $g['x'] - $last['x1'] < 2 * $sp) {
                $runs[count($runs) - 1]['g'][] = $g;
                $runs[count($runs) - 1]['x1'] = $g['x'];
            } else {
                $runs[] = ['x' => $g['x'], 'x1' => $g['x'], 'g' => [$g]];
            }
        }
        foreach ($runs as $r) {
            $sharps = count(array_filter($r['g'], fn ($g) => $g['cp'] === 0xE262));
            $flats = count(array_filter($r['g'], fn ($g) => $g['cp'] === 0xE260));
            $events[] = ['t' => 'key', 'x' => $r['x'], 'fifths' => $sharps ? $sharps : -$flats];
        }
        // Clef and time signatures
        foreach ($glyphs as $g) {
            if (isset(self::CLEFS[$g['cp']]) && $g['size'] >= $normal * 0.85) $events[] = ['t' => 'clef', 'x' => $g['x'], 'clef' => self::CLEFS[$g['cp']]];
        }
        $digits = array_values(array_filter($glyphs, fn ($g) => (($g['cp'] >= 0xE080 && $g['cp'] <= 0xE089) || $g['cp'] === 0xE08A || $g['cp'] === 0xE08B) && $g['y'] > $st['top'] - $sp && $g['y'] < $st['bottom'] + $sp));
        usort($digits, fn ($a, $b) => $a['x'] <=> $b['x']);
        $mid = ($st['top'] + $st['bottom']) / 2;
        $used = [];
        foreach ($digits as $i => $d) {
            if (isset($used[$i])) continue;
            if ($d['cp'] === 0xE08A || $d['cp'] === 0xE08B) {
                $events[] = ['t' => 'time', 'x' => $d['x'], 'meter' => $d['cp'] === 0xE08A ? 'C' : 'C|', 'beats' => $d['cp'] === 0xE08A ? 4 : 2, 'unit' => $d['cp'] === 0xE08A ? 4 : 2];
                continue;
            }
            $group = [];
            foreach ($digits as $j => $e) {
                if (!isset($used[$j]) && abs($e['x'] - $d['x']) < 2.5 * $sp && $e['cp'] >= 0xE080 && $e['cp'] <= 0xE089) { $group[] = $e; $used[$j] = true; }
            }
            $top = $bot = '';
            usort($group, fn ($a, $b) => $a['x'] <=> $b['x']);
            foreach ($group as $e) {
                if ($e['y'] < $mid) $top .= (string) ($e['cp'] - 0xE080);
                else $bot .= (string) ($e['cp'] - 0xE080);
            }
            if ($top !== '' && $bot !== '') $events[] = ['t' => 'time', 'x' => $d['x'], 'meter' => "$top/$bot", 'beats' => (int) $top, 'unit' => (int) $bot];
        }

        // Dots
        $dots = array_values(array_filter($glyphs, fn ($g) => $g['cp'] === self::DOT));
        // Beams: filled four-sided shapes, about half a space thick.
        $beams = [];
        foreach ($st['fills'] as $f) {
            if ($f['curve']) continue;
            $pts = $f['pts'];
            if (count($pts) === 5 && abs($pts[0][0] - $pts[4][0]) < 0.01 && abs($pts[0][1] - $pts[4][1]) < 0.01) array_pop($pts);
            if (count($pts) !== 4) continue;
            $xs = array_column($pts, 0);
            $x0 = min($xs);
            $x1 = max($xs);
            if ($x1 - $x0 < 0.5 * $sp) continue;
            // left edge (two points at x0) and right edge
            $l = array_values(array_filter($pts, fn ($p) => abs($p[0] - $x0) < 0.05));
            $r = array_values(array_filter($pts, fn ($p) => abs($p[0] - $x1) < 0.05));
            if (count($l) !== 2 || count($r) !== 2) continue;
            $thick = abs($l[0][1] - $l[1][1]);
            if ($thick < 0.25 * $sp || $thick > 0.8 * $sp) continue;
            $beams[] = ['x0' => $x0, 'x1' => $x1, 'yl' => ($l[0][1] + $l[1][1]) / 2, 'yr' => ($r[0][1] + $r[1][1]) / 2];
        }
        $flags = array_values(array_filter($glyphs, fn ($g) => isset(self::FLAGS[$g['cp']]) && $g['size'] >= $normal * 0.85));
        // A beam belongs to this staff when one of its ends touches one of this staff's stems
        // (a neighbouring staff's beams can come close in the gap between them).
        $ownStems = array_values(array_filter(array_map(fn ($c) => $c['stem'], $chords)));
        $beams = array_values(array_filter($beams, function ($b) use ($ownStems, $sp) {
            foreach ($ownStems as $s) {
                foreach ([[$b['x0'], $b['yl']], [$b['x1'], $b['yr']]] as [$x, $y]) {
                    if (abs($s['x'] - $x) < 0.4 * $sp && $y > $s['y0'] - 0.6 * $sp && $y < $s['y1'] + 0.6 * $sp) return true;
                }
            }
            return false;
        }));

        foreach ($chords as $c) {
            usort($c['heads'], fn ($a, $b) => $b['pos'] <=> $a['pos']); // top note first
            $top = $c['heads'][0];
            $value = $top['value'];
            $beamCount = 0;
            $beamIds = [];
            $up = null;
            if ($c['stem'] !== null && $value <= 1) {
                $s = $c['stem'];
                $up = abs($top['y'] - $s['y1']) < abs($top['y'] - $s['y0']) || abs($c['heads'][count($c['heads']) - 1]['y'] - $s['y1']) < 0.7 * $sp;
                $tip = $up ? $s['y0'] : $s['y1'];
                foreach ($flags as $fl) {
                    if (abs($fl['x'] - $s['x']) < 0.5 * $sp && abs($fl['y'] - $tip) < 1.5 * $sp) $beamCount = max($beamCount, self::FLAGS[$fl['cp']]);
                }
                $nb = 0;
                foreach ($beams as $bi => $b) {
                    if ($s['x'] < $b['x0'] - 0.3 * $sp || $s['x'] > $b['x1'] + 0.3 * $sp) continue;
                    $t = ($s['x'] - $b['x0']) / max(0.001, $b['x1'] - $b['x0']);
                    $by = $b['yl'] + ($b['yr'] - $b['yl']) * max(0, min(1, $t));
                    // beams stack from the stem tip towards the notehead
                    $d = $up ? $by - $tip : $tip - $by;
                    if ($d > -2.5 * $sp && $d < 2.6 * $sp) { $nb++; $beamIds[] = $bi; } // (some stems stop short of their beam)
                }
                $beamCount = max($beamCount, $nb);
            }
            $length = $value / (2 ** $beamCount);
            // Augmentation dots right of the top note
            $right = max(array_column($c['heads'], 'x1'));
            $nd = 0;
            foreach ($dots as $d) {
                if ($d['x'] > $right && $d['x'] - $right < (1.2 + 0.7 * $nd) * $sp && abs($d['y'] - $top['y']) < 0.8 * $sp) $nd++;
            }
            $nd = min($nd, 2);
            $length *= [1, 1.5, 1.75][$nd];
            $events[] = ['t' => 'note', 'x' => $top['x'], 'x1' => $right, 'y' => $top['y'], 'pos' => $top['pos'], 'acc' => $top['acc'], 'len' => $length, 'stem' => $c['stem'], 'up' => $up, 'beams' => $beamCount, 'beamIds' => $beamIds];
        }
        foreach ($glyphs as $g) {
            if (!isset(self::RESTS[$g['cp']]) || $g['size'] < $normal * 0.85) continue;
            $len = self::RESTS[$g['cp']];
            $nd = 0;
            foreach ($dots as $d) if ($d['x'] > $g['x'] + $g['w'] && $d['x'] - $g['x'] - $g['w'] < 1.5 * $sp && abs($d['y'] - $g['y']) < 1.5 * $sp) $nd = 1;
            $events[] = ['t' => 'rest', 'x' => $g['x'], 'x1' => $g['x'] + $g['w'], 'len' => $len * ($nd ? 1.5 : 1), 'whole' => $g['cp'] === 0xE4E3, 'y' => $g['y']];
        }
        // Ties: curves from one notehead to the next note of the same pitch.
        foreach ($st['curves'] as $cv) {
            $xs = array_column($cv['pts'], 0);
            $x0 = min($xs);
            $x1 = max($xs);
            $ys = array_column($cv['pts'], 1);
            if ($x1 - $x0 < 0.8 * $sp) continue;
            $yl = $cv['pts'][array_search($x0, $xs)][1];
            $events[] = ['t' => 'curve', 'x' => $x0, 'x1' => $x1, 'yl' => $yl, 'yr' => $cv['pts'][array_search($x1, $xs)][1], 'h' => max($ys) - min($ys)];
        }
        // Tuplet numbers
        foreach ($glyphs as $g) {
            if ($g['cp'] >= 0xE880 && $g['cp'] <= 0xE889) $events[] = ['t' => 'tuplet', 'x' => $g['x'] + $g['w'] / 2, 'n' => $g['cp'] - 0xE880, 'y' => $g['y']];
            if ($g['cp'] === self::SEGNO) $events[] = ['t' => 'text', 'x' => $g['x'], 'text' => 'S', 'deco' => '!segno!'];
            if ($g['cp'] === self::CODA) $events[] = ['t' => 'text', 'x' => $g['x'], 'text' => 'O', 'deco' => '!coda!'];
        }
        // Text: chord symbols above the staff, volta numbers, directions.
        foreach ($st['words'] as $w) {
            $t = $w['text'];
            if (preg_match('/^\d+$/', $t) && $w['size'] < 0.9 * 4 * $sp && $w['x'] < $st['x0'] + 2 * $sp) continue; // measure number
            if (preg_match('/^[2-9]$/', $t) && isset($w['fonts']['Edwin-Italic'])) { $events[] = ['t' => 'tuplet', 'x' => ($w['x'] + $w['x1']) / 2, 'n' => (int) $t, 'y' => $w['y']]; continue; }
            if (preg_match('/^(\d\.\s*,?\s*)+$/', $t) && $w['y'] < $st['top']) {
                // the ending starts at the barline under the start of its bracket
                $x = $w['x'];
                foreach ($barGroups as $bg) if (abs($bg['x1'] - $w['x']) < 2 * $sp) $x = $bg['x1'] + 0.01;
                $events[] = ['t' => 'volta', 'x' => $x, 'text' => rtrim(preg_replace('/[.\s]+/', ',', $t), ',')];
                continue;
            }
            if (self::isChord($t) && $w['y'] < $st['top'] && empty($w['lyric'])) { $events[] = ['t' => 'chord', 'x' => $w['x'], 'text' => $t]; continue; }
            if (empty($w['lyric']) && preg_match('/^(D\.\s?C\.|D\.\s?S\.|Fine|To Coda|Coda)/', $t)) { $events[] = ['t' => 'text', 'x' => $w['x'], 'text' => $t]; continue; }
            if (preg_match('/=\s*(\d{2,3})/', $t, $m) && $this->tempo === null) $this->tempo = ['bpm' => (int) $m[1], 'text' => $t];
        }
        usort($events, fn ($a, $b) => $a['x'] <=> $b['x'] ?: self::order($a['t']) <=> self::order($b['t']));
        return $events;
    }

    private static function order(string $t): int
    {
        return ['bar' => 0, 'clef' => 1, 'key' => 2, 'time' => 3, 'volta' => 4, 'text' => 5, 'chord' => 6, 'tuplet' => 7, 'curve' => 8, 'note' => 9, 'rest' => 9][$t] ?? 9;
    }

    public static function isChord(string $t): bool
    {
        return preg_match('/^[A-G][#b♯♭]?(m|min|maj|M|dim|aug|sus|add|°|ø|\+)?[0-9]*(sus[24]?|add[0-9]+|maj[0-9]*|[#b♯♭][0-9]+)*(\([^)]*\))?(\/[A-G][#b♯♭]?)?$/u', $t) === 1;
    }

    // ------------------------------------------------------------------ assemble

    public function result(string $fallbackTitle = ''): ?array
    {
        if (!$this->systems) return null;
        $clef = 'treble';
        $fifths = null;
        $meter = null;
        $cur = ['tokens' => [], 'len' => 0.0]; // the bar being written
        $lines = [];  // ABC body lines (one per system)
        $tupletLeft = 0;
        $tupletN = 0;
        $textQueue = [];
        $notes = 0;
        $allLens = [];
        $barLens = [];
        $line = '';
        $firstMeter = null;
        $firstKey = null;

        foreach ($this->systems as $sysIdx => $st) {
            $ev = $this->readStaff($st);
            $sp = $st['sp'];
            // Tuplets: mark the notes under each tuplet number.
            $noteIdx = [];
            foreach ($ev as $i => $e) if ($e['t'] === 'note' || $e['t'] === 'rest') $noteIdx[] = $i;
            foreach ($ev as $e) {
                if ($e['t'] !== 'tuplet' || $e['n'] < 2) continue;
                // nearest note/rest to the number, then the group of n around it
                $best = null;
                foreach ($noteIdx as $k => $i) {
                    $cx = ($ev[$i]['x'] + $ev[$i]['x1']) / 2;
                    if ($best === null || abs($cx - $e['x']) < abs(($ev[$noteIdx[$best]]['x'] + $ev[$noteIdx[$best]]['x1']) / 2 - $e['x'])) $best = $k;
                }
                if ($best === null) continue;
                $n = $e['n'];
                $start = max(0, min(count($noteIdx) - $n, $best - intdiv($n - 1, 2)));
                // Prefer a start whose group is centred on the number
                $bestStart = $start;
                $bestErr = INF;
                for ($s0 = max(0, $best - $n + 1); $s0 <= min($best, count($noteIdx) - $n); $s0++) {
                    $c = ($ev[$noteIdx[$s0]]['x'] + $ev[$noteIdx[$s0 + $n - 1]]['x1']) / 2;
                    if (abs($c - $e['x']) < $bestErr) { $bestErr = abs($c - $e['x']); $bestStart = $s0; }
                }
                if (!isset($ev[$noteIdx[$bestStart]]['tuplet'])) $ev[$noteIdx[$bestStart]]['tuplet'] = $n;
            }
            // A note joins the next one (no space in ABC) when a beam connects them.
            for ($k = 0; $k + 1 < count($noteIdx); $k++) {
                $a = $ev[$noteIdx[$k]];
                $b = $ev[$noteIdx[$k + 1]];
                if (!empty($a['beamIds']) && !empty($b['beamIds']) && array_intersect($a['beamIds'], $b['beamIds'])) $ev[$noteIdx[$k]]['beamNext'] = true;
            }
            // Chord symbols belong to the note or rest nearest below them.
            foreach ($ev as $i => $e) {
                if ($e['t'] !== 'chord') continue;
                $best = null;
                foreach ($noteIdx as $j) if ($best === null || abs($ev[$j]['x'] - $e['x']) < abs($ev[$best]['x'] - $e['x'])) $best = $j;
                if ($best !== null) $ev[$best]['chord'] = $e['text'];
            }
            // Ties: a curve starting at a note and ending at the next note of the same pitch.
            foreach ($ev as $i => $e) {
                if ($e['t'] !== 'curve') continue;
                $from = $to = null;
                foreach ($ev as $j => $n) {
                    if ($n['t'] !== 'note') continue;
                    if ($from === null || abs($n['x1'] - $e['x']) < abs($ev[$from]['x1'] - $e['x'])) $from = $j;
                }
                if ($from === null || abs($ev[$from]['x1'] - $e['x']) > 1.5 * $sp || abs($ev[$from]['y'] - $e['yl']) > 2 * $sp) continue;
                foreach ($ev as $j => $n) {
                    if ($n['t'] === 'note' && $n['x'] > $ev[$from]['x1'] && ($to === null || $n['x'] < $ev[$to]['x'])) $to = $j;
                }
                if ($to !== null && abs($ev[$to]['x'] - $e['x1']) < 1.5 * $sp) {
                    if ($ev[$to]['pos'] === $ev[$from]['pos']) $ev[$from]['tie'] = true;
                } elseif ($e['x1'] > $st['x1'] - 2 * $sp) {
                    $ev[$from]['tie'] = true; // continues on the next line
                }
            }

            $line = '';
            if (isset($st['title'])) {
                // "(B)" labels a part of the tune; "Name (A)" starts a new tune at part A.
                if (preg_match('/^(.*?)\s*\(?([A-H])\)?$/u', $st['title'], $m) && ($m[1] === '' || str_ends_with($st['title'], ')'))) {
                    $line = ($m[1] !== '' ? 'T:' . $m[1] . "\n" : '') . 'P:' . $m[2] . "\n";
                } else {
                    $line = 'T:' . $st['title'] . "\n";
                }
            }
            $first = true;
            foreach ($ev as $e) {
                switch ($e['t']) {
                    case 'clef':
                        $clef = $e['clef'];
                        break;
                    case 'key':
                        if ($fifths === null) { $fifths = $e['fifths']; $firstKey = $fifths; }
                        elseif ($e['fifths'] !== $fifths && $e['x'] > $st['x0'] + 8 * $sp) {
                            $fifths = $e['fifths'];
                            $line .= '[K:' . self::keyName($fifths) . '] ';
                            $cur['restart'] = true;
                        }
                        break;
                    case 'time':
                        if ($meter === null) { $meter = $e; $firstMeter = $e; }
                        elseif ($e['meter'] !== $meter['meter']) { $meter = $e; $line .= '[M:' . $e['meter'] . '] '; $cur['restart'] = true; }
                        break;
                    case 'bar':
                        if ($e['atStart'] && $first) {
                            if (str_contains($e['sym'], ':') || $e['sym'] === '[|') $line .= ($e['sym'] === '::' ? '|:' : $e['sym']) . ' ';
                            break;
                        }
                        if ($cur['tokens'] || $cur['len'] > 0) {
                            $barLens[] = ['len' => $cur['len'], 'full' => $meter ? $meter['beats'] * 4 / $meter['unit'] : null, 'end' => $e['sym'], 'restart' => $cur['restart'] ?? false];
                            $line .= implode('', $cur['tokens']);
                            $cur = ['tokens' => [], 'len' => 0.0];
                        }
                        $line .= $e['sym'] . ' ';
                        break;
                    case 'volta':
                        // Endings go right after the barline that starts them.
                        $line = rtrim($line);
                        if (preg_match('/\|\s*$|:\s*$/', $line)) $line .= '[' . $e['text'] . ' ';
                        else $line .= ' [' . $e['text'] . ' ';
                        break;
                    case 'text':
                        $textQueue[] = $e['deco'] ?? ('"^' . str_replace('"', '', $e['text']) . '"');
                        break;
                    case 'note':
                    case 'rest':
                        $first = false;
                        $len = $e['len'];
                        $tok = '';
                        foreach ($textQueue as $t) $tok .= $t;
                        $textQueue = [];
                        if (isset($e['chord'])) $tok .= '"' . $e['chord'] . '"';
                        if (!empty($e['tuplet'])) {
                            $tupletN = $e['tuplet'];
                            $tupletLeft = $tupletN;
                            $tok = '(' . $tupletN . $tok;
                        }
                        if ($tupletLeft > 0) {
                            $len *= $tupletN === 3 ? 2 / 3 : ($tupletN === 2 ? 3 / 2 : ($tupletN === 4 ? 3 / 4 : ($tupletN === 6 ? 2 / 3 : 1)));
                            $tupletLeft--;
                        }
                        if ($e['t'] === 'rest') {
                            // MuseScore draws a whole-bar rest as a whole rest, whatever the time signature.
                            if ($e['whole'] && $meter) $e['len'] = $len = $meter['beats'] * 4 / $meter['unit'];
                            $tok .= 'z';
                        } else {
                            $tok .= self::pitch($e['pos'], $e['acc'], $clef);
                            $notes++;
                        }
                        $tok .= '%LEN' . $e['len'] . '%';
                        if (!empty($e['tie'])) $tok .= '-';
                        // beam grouping: space after notes that aren't beamed to the next
                        if (empty($e['beamNext'])) $tok .= ' ';
                        $cur['tokens'][] = $tok;
                        $cur['len'] += $len;
                        $allLens[] = $e['len'];
                        break;
                }
            }
            if ($cur['tokens']) {
                // bar continues on the next line (no barline at the end of the system)
                $line .= implode('', $cur['tokens']);
                $cur['tokens'] = [];
            }
            foreach ($textQueue as $t) $line .= $t . ' ';
            $textQueue = [];
            $lines[] = $line;
        }
        if ($cur['len'] > 0) $barLens[] = ['len' => $cur['len'], 'full' => $meter ? $meter['beats'] * 4 / $meter['unit'] : null, 'end' => '|]', 'restart' => $cur['restart'] ?? false];
        if ($notes === 0 || $firstMeter === null && count($barLens) < 1) return null;

        // Unit note length: eighth for most tunes, quarter when there are few short notes.
        $short = count(array_filter($allLens, fn ($l) => $l < 1));
        $unitBeats = ($firstMeter && $firstMeter['unit'] === 8) || $short > count($allLens) * 0.25 ? 0.5 : 1.0;
        $body = implode("\n", array_map(fn ($l) => self::finishLine($l, $unitBeats), $lines));

        // Check the bars add up to the time signature.
        $warnings = $this->warnings;
        $bad = self::badBars($barLens);
        if ($firstMeter) {
            if ($bad > max(2, count($barLens) * 0.1)) return null;
            if ($bad) $warnings[] = "$bad bar(s) don't add up to the time signature; check them against the original.";
        }

        $title = $this->title() ?: $fallbackTitle ?: 'Untitled';
        $head = "X:1\nT:" . $title . "\n";
        $composer = $this->composer();
        if ($composer) $head .= "C:$composer\n";
        $head .= 'M:' . ($firstMeter['meter'] ?? '4/4') . "\n";
        $head .= 'L:' . ($unitBeats === 0.5 ? '1/8' : '1/4') . "\n";
        if ($this->tempo) $head .= 'Q:1/4=' . $this->tempo['bpm'] . "\n";
        $head .= 'K:' . self::keyName($firstKey ?? 0) . ($clef === 'bass' ? ' clef=bass' : '') . "\n";
        $abc = $head . $body . "\n";
        foreach ($warnings as $w) $abc .= "% $w\n";
        return ['abc' => $abc, 'warnings' => $warnings, 'bars' => count($barLens), 'notes' => $notes];
    }

    /**
     * Bars whose notes don't fill the time signature. Short bars are fine at the start and
     * end of a tune (pickups) and on either side of a repeat sign or ending; over-full bars
     * and short bars mid-phrase are not.
     */
    private static function badBars(array $bars): int
    {
        $n = count($bars);
        $bad = 0;
        $boundary = fn (string $sym) => str_contains($sym, ':') || $sym === '||' || $sym === '|]' || $sym === '[|';
        for ($i = 0; $i < $n; $i++) {
            $b = $bars[$i];
            if ($b['full'] === null || abs($b['len'] - $b['full']) < 0.01) continue;
            if ($b['len'] < $b['full']) {
                $startsTune = $i === 0 || $b['restart'] || in_array($bars[$i - 1]['end'], ['||', '|]'], true);
                $endsTune = $i === $n - 1 || in_array($b['end'], ['||', '|]'], true) || $bars[$i + 1]['restart'];
                if ($startsTune || $endsTune) continue;
                // either side of a repeat sign or ending (pickups into a section; the bar before it)
                if ($boundary($b['end']) || ($i > 0 && $boundary($bars[$i - 1]['end']))) continue;
            }
            $bad++;
        }
        return $bad;
    }

    private static function finishLine(string $line, float $unit): string
    {
        $line = preg_replace_callback('/%LEN([0-9.E-]+)%/', function ($m) use ($unit) {
            return self::lenStr((float) $m[1] / $unit);
        }, $line);
        $line = preg_replace('/ {2,}/', ' ', $line);
        return trim($line);
    }

    private static function lenStr(float $units): string
    {
        foreach ([1, 2, 4, 8, 16] as $den) {
            $num = $units * $den;
            if (abs($num - round($num)) < 0.01) {
                $num = (int) round($num);
                if ($den === 1) return $num === 1 ? '' : (string) $num;
                if ($num === 1) return str_repeat('/', 1) . ($den === 2 ? '' : (string) $den);
                return $num . '/' . $den;
            }
        }
        return '';
    }

    /** ABC pitch from staff position (0 = bottom line). */
    private static function pitch(int $pos, string $acc, string $clef): string
    {
        // diatonic step number: C4 = 28
        $bottom = match ($clef) { 'bass' => 4 * 7 - 10, 'alto' => 4 * 7 - 4, default => 4 * 7 + 2 }; // G2, F3, E4
        $d = $bottom + $pos;
        $oct = intdiv($d, 7);
        $letter = 'CDEFGAB'[$d % 7];
        if ($oct >= 5) {
            $s = strtolower($letter) . str_repeat("'", $oct - 5);
        } else {
            $s = $letter . str_repeat(',', max(0, 4 - $oct));
        }
        return $acc . $s;
    }

    private static function keyName(int $fifths): string
    {
        $names = [-7 => 'Cb', -6 => 'Gb', -5 => 'Db', -4 => 'Ab', -3 => 'Eb', -2 => 'Bb', -1 => 'F', 0 => 'C', 1 => 'G', 2 => 'D', 3 => 'A', 4 => 'E', 5 => 'B', 6 => 'F#', 7 => 'C#'];
        return $names[max(-7, min(7, $fifths))];
    }

    private function title(): string
    {
        if (!$this->headerText) return '';
        $big = array_reduce($this->headerText, fn ($a, $w) => $a === null || $w['size'] > $a['size'] ? $w : $a);
        // join words on the same line at that size
        $same = array_filter($this->headerText, fn ($w) => abs($w['size'] - $big['size']) < 0.5 && abs($w['y'] - $big['y']) < 1);
        usort($same, fn ($a, $b) => $a['x'] <=> $b['x']);
        return trim(implode(' ', array_column($same, 'text')));
    }

    private function composer(): string
    {
        // MuseScore puts the composer right-aligned under the title.
        $title = $this->title();
        if (!$title) return '';
        $maxX = max(array_column($this->headerText, 'x1'));
        $sizes = array_column($this->headerText, 'size');
        $tsize = max($sizes);
        foreach ($this->headerText as $w) {
            if ($w['size'] < $tsize * 0.8 && abs($w['x1'] - $maxX) < 2 && $w['size'] > 7 && !preg_match('/^\d{4}-\d\d-\d\d$/', $w['text'])) return $w['text'];
        }
        return '';
    }
}
