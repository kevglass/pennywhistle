<?php
// Runs a page's content stream and collects what it draws, in page points with y going down:
//   glyphs: ['font' => base font name, 'ch' => character, 'x', 'y' (origin), 'size' (em, points), 'w' (advance), 'run' (text object)]
//   strokes: ['pts' => [[x, y], ...], 'width', 'curve' => bool]   (one per subpath)
//   fills:   ['pts' => [[x, y], ...], 'curve' => bool]            (one per subpath)
declare(strict_types=1);

require_once __DIR__ . '/pdf.php';

final class PdfFont
{
    public string $base = '';
    public bool $twoByte = false;
    /** @var array<int, string> */
    public array $unicode = [];
    /** @var array<int, float> advance per code, 1000-unit em */
    public array $widths = [];
    public float $defaultWidth = 1000;

    private static ?array $edwin = null;

    public static function load(PdfDoc $doc, mixed $ref): self
    {
        $f = new self();
        $d = $doc->get($ref);
        if (!is_array($d)) return $f;
        $f->base = preg_replace('/^[A-Z]{6}\+/', '', (string) $doc->name($d['BaseFont'] ?? null));
        $sub = $doc->name($d['Subtype'] ?? null);
        $fontFile = null;
        if ($sub === 'Type0') {
            $f->twoByte = true;
            $desc = $doc->get(($doc->get($d['DescendantFonts'] ?? []))[0] ?? null);
            if (is_array($desc)) {
                $f->defaultWidth = (float) ($doc->get($desc['DW'] ?? 1000));
                $w = $doc->get($desc['W'] ?? []);
                for ($i = 0; is_array($w) && $i < count($w);) {
                    $first = (int) $doc->get($w[$i]);
                    $next = $doc->get($w[$i + 1] ?? null);
                    if (is_array($next)) {
                        foreach (array_values($next) as $k => $v) $f->widths[$first + $k] = (float) $doc->get($v);
                        $i += 2;
                    } else {
                        $last = (int) $next;
                        $v = (float) $doc->get($w[$i + 2] ?? 0);
                        for ($c = $first; $c <= $last && $c - $first < 65536; $c++) $f->widths[$c] = $v;
                        $i += 3;
                    }
                }
                $fd = $doc->get($desc['FontDescriptor'] ?? null);
                if (is_array($fd)) $fontFile = $doc->get($fd['FontFile2'] ?? null);
            }
        } else {
            $first = (int) $doc->get($d['FirstChar'] ?? 0);
            foreach ((array) $doc->get($d['Widths'] ?? []) as $k => $v) $f->widths[$first + $k] = (float) $doc->get($v);
            for ($c = 32; $c < 256; $c++) $f->unicode[$c] = mb_convert_encoding(chr($c), 'UTF-8', 'Windows-1252');
            $fd = $doc->get($d['FontDescriptor'] ?? null);
            if (is_array($fd)) $fontFile = $doc->get($fd['FontFile2'] ?? null);
        }
        $tu = $doc->get($d['ToUnicode'] ?? null);
        if ($tu instanceof PdfStream) $f->parseCMap($doc->decode($tu));
        // MuseScore's text font is embedded without a character map: identify glyphs by their metrics.
        if (str_starts_with($f->base, 'Edwin') && !self::looksMapped($f->unicode) && $fontFile instanceof PdfStream) {
            $f->identifyEdwin($doc->decode($fontFile));
        }
        return $f;
    }

    private static function looksMapped(array $u): bool
    {
        foreach ($u as $s) if (preg_match('/[A-Za-z0-9]/', $s)) return true;
        return false;
    }

    private function parseCMap(string $cm): void
    {
        $hexToStr = function (string $h): string {
            $b = (string) hex2bin(strlen($h) % 2 ? $h . '0' : $h);
            return mb_convert_encoding($b, 'UTF-8', 'UTF-16BE');
        };
        if (preg_match_all('/beginbfchar(.*?)endbfchar/s', $cm, $blocks)) {
            foreach ($blocks[1] as $b) {
                preg_match_all('/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/', $b, $m, PREG_SET_ORDER);
                foreach ($m as $x) $this->unicode[hexdec($x[1])] = $hexToStr($x[2]);
            }
        }
        if (preg_match_all('/beginbfrange(.*?)endbfrange/s', $cm, $blocks)) {
            foreach ($blocks[1] as $b) {
                preg_match_all('/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/', $b, $m, PREG_SET_ORDER);
                foreach ($m as $x) {
                    $lo = hexdec($x[1]);
                    $hi = hexdec($x[2]);
                    if ($hi - $lo > 65535) continue;
                    if ($x[3][0] === '[') {
                        preg_match_all('/<([0-9A-Fa-f]*)>/', $x[3], $items);
                        foreach ($items[1] as $k => $h) $this->unicode[$lo + $k] = $hexToStr($h);
                    } else {
                        $start = substr($x[3], 1, -1);
                        $base = hexdec($start);
                        for ($c = $lo; $c <= $hi; $c++) {
                            $this->unicode[$c] = $hexToStr(str_pad(dechex($base + $c - $lo), strlen($start), '0', STR_PAD_LEFT));
                        }
                    }
                }
            }
        }
    }

    /** Match each embedded glyph's advance and outline bounds against the full Edwin font. */
    private function identifyEdwin(string $ttf): void
    {
        self::$edwin ??= json_decode((string) file_get_contents(__DIR__ . '/edwin-metrics.json'), true);
        $style = match (true) {
            str_contains($this->base, 'BdIta') || str_contains($this->base, 'BoldItalic') => 'BdIta',
            str_contains($this->base, 'Bold') => 'Bold',
            str_contains($this->base, 'Italic') => 'Italic',
            default => 'Roman',
        };
        $ref = self::$edwin[$style] ?? [];
        $bounds = self::glyphBounds($ttf);
        if (!$bounds || !$ref) return;
        foreach ($bounds as $gid => $b) {
            if ($gid === 0) continue;
            $adv = $this->widths[$gid] ?? $this->defaultWidth;
            $best = null;
            $bestScore = INF;
            foreach ($ref as $r) {
                $score = abs($r[1] - $adv) * 3 + abs($r[2] - $b[0]) + abs($r[3] - $b[1]) + abs($r[4] - $b[2]) + abs($r[5] - $b[3]);
                if ($score < $bestScore) { $bestScore = $score; $best = $r[0]; }
            }
            if ($best !== null && $bestScore <= 40) $this->unicode[$gid] = $best;
        }
    }

    /** Glyph bounding boxes (1000-unit em) from a TrueType font's glyf table, by glyph id. */
    private static function glyphBounds(string $ttf): array
    {
        if (strlen($ttf) < 12) return [];
        $numTables = unpack('n', $ttf, 4)[1];
        $tables = [];
        for ($i = 0; $i < $numTables; $i++) {
            $rec = unpack('a4tag/Nsum/Noff/Nlen', $ttf, 12 + $i * 16);
            $tables[$rec['tag']] = [$rec['off'], $rec['len']];
        }
        if (!isset($tables['head'], $tables['loca'], $tables['glyf'], $tables['maxp'])) return [];
        $upm = unpack('n', $ttf, $tables['head'][0] + 18)[1] ?: 1000;
        $longLoca = unpack('n', $ttf, $tables['head'][0] + 50)[1] === 1;
        $count = unpack('n', $ttf, $tables['maxp'][0] + 4)[1];
        $out = [];
        $s = 1000 / $upm;
        for ($g = 0; $g < $count; $g++) {
            if ($longLoca) {
                [$a, $b] = array_values(unpack('N2', $ttf, $tables['loca'][0] + $g * 4));
            } else {
                [$a, $b] = array_values(unpack('n2', $ttf, $tables['loca'][0] + $g * 2));
                $a *= 2;
                $b *= 2;
            }
            if ($b <= $a) { $out[$g] = [0, 0, 0, 0]; continue; }
            $h = unpack('nn/nx0/ny0/nx1/ny1', $ttf, $tables['glyf'][0] + $a);
            $sx = fn ($v) => ($v >= 32768 ? $v - 65536 : $v) * $s;
            $out[$g] = [round($sx($h['x0'])), round($sx($h['y0'])), round($sx($h['x1'])), round($sx($h['y1']))];
        }
        return $out;
    }

    /** Split a shown string into [code, char] pairs. */
    public function codes(string $s): array
    {
        $out = [];
        if ($this->twoByte) {
            for ($i = 0; $i + 1 < strlen($s); $i += 2) {
                $c = (ord($s[$i]) << 8) | ord($s[$i + 1]);
                $out[] = [$c, $this->unicode[$c] ?? ''];
            }
        } else {
            for ($i = 0; $i < strlen($s); $i++) {
                $c = ord($s[$i]);
                $out[] = [$c, $this->unicode[$c] ?? ''];
            }
        }
        return $out;
    }

    public function width(int $code): float
    {
        return $this->widths[$code] ?? $this->defaultWidth;
    }
}

final class PdfContent
{
    public array $glyphs = [];
    public array $strokes = [];
    public array $fills = [];
    public int $images = 0;
    private int $run = 0; // text object counter: glyphs from one BT..ET block share a run
    public float $width = 0;
    public float $height = 0;

    private array $fontCache = [];

    public function __construct(private PdfDoc $doc) {}

    public static function page(PdfDoc $doc, array $page): self
    {
        $c = new self($doc);
        $box = array_map(fn ($v) => (float) $doc->get($v), (array) $doc->get($page['MediaBox'] ?? [0, 0, 595, 842]));
        [$x0, $y0, $x1, $y1] = $box + [0, 0, 595, 842];
        $c->width = $x1 - $x0;
        $c->height = $y1 - $y0;
        // page space -> y-down points
        $base = [1, 0, 0, -1, -$x0, $y1];
        $c->run($doc->pageContent($page), (array) $doc->get($page['Resources'] ?? []), $base, 0);
        return $c;
    }

    private static function mul(array $a, array $b): array
    {
        return [
            $a[0] * $b[0] + $a[1] * $b[2], $a[0] * $b[1] + $a[1] * $b[3],
            $a[2] * $b[0] + $a[3] * $b[2], $a[2] * $b[1] + $a[3] * $b[3],
            $a[4] * $b[0] + $a[5] * $b[2] + $b[4], $a[4] * $b[1] + $a[5] * $b[3] + $b[5],
        ];
    }

    private static function apply(array $m, float $x, float $y): array
    {
        return [$x * $m[0] + $y * $m[2] + $m[4], $x * $m[1] + $y * $m[3] + $m[5]];
    }

    private function font(array $res, string $name): PdfFont
    {
        $fonts = (array) $this->doc->get($res['Font'] ?? []);
        $ref = $fonts[$name] ?? null;
        $key = $ref instanceof PdfRef ? 'r' . $ref->num : 'n' . $name . spl_object_id((object) $fonts);
        return $this->fontCache[$key] ??= PdfFont::load($this->doc, $ref);
    }

    private function run(string $src, array $res, array $ctm, int $depth): void
    {
        if ($depth > 8) return;
        $p = new PdfParser($src, true);
        $stack = [];
        $gs = ['ctm' => $ctm, 'lw' => 1.0];
        $text = ['font' => null, 'size' => 0.0, 'tm' => [1, 0, 0, 1, 0, 0], 'tlm' => [1, 0, 0, 1, 0, 0], 'tc' => 0.0, 'tw' => 0.0, 'th' => 1.0, 'tl' => 0.0, 'rise' => 0.0];
        $path = []; // subpaths: ['pts' => [...], 'curve' => bool]
        $cur = null;
        $ops = [];
        $flush = function (string $kind) use (&$path, &$cur, &$gs) {
            if ($cur !== null) { $path[] = $cur; $cur = null; }
            $scale = sqrt(abs($gs['ctm'][0] * $gs['ctm'][3] - $gs['ctm'][1] * $gs['ctm'][2]));
            foreach ($path as $sp) {
                if (count($sp['pts']) < 2) continue;
                if ($kind === 'S') $this->strokes[] = ['pts' => $sp['pts'], 'width' => $gs['lw'] * $scale, 'curve' => $sp['curve']];
                elseif ($kind === 'f') $this->fills[] = ['pts' => $sp['pts'], 'curve' => $sp['curve']];
            }
            $path = [];
        };
        while (!$p->eof()) {
            $v = $p->value();
            if (!is_array($v) || !isset($v['op'])) { $ops[] = $v; continue; }
            $op = $v['op'];
            $n = fn (int $i) => (float) ($ops[$i] ?? 0);
            switch ($op) {
                case 'q': $stack[] = [$gs, $text]; break;
                case 'Q': if ($stack) [$gs, $text] = array_pop($stack); break;
                case 'cm': $gs['ctm'] = self::mul([$n(0), $n(1), $n(2), $n(3), $n(4), $n(5)], $gs['ctm']); break;
                case 'w': $gs['lw'] = $n(0); break;
                case 'm':
                    if ($cur !== null) $path[] = $cur;
                    $cur = ['pts' => [self::apply($gs['ctm'], $n(0), $n(1))], 'curve' => false];
                    break;
                case 'l':
                    if ($cur !== null) $cur['pts'][] = self::apply($gs['ctm'], $n(0), $n(1));
                    break;
                case 'c': case 'v': case 'y':
                    if ($cur === null) break;
                    $last = $cur['pts'][count($cur['pts']) - 1];
                    $k = count($ops);
                    $end = self::apply($gs['ctm'], $n($k - 2), $n($k - 1));
                    $c1 = $op === 'v' ? $last : self::apply($gs['ctm'], $n(0), $n(1));
                    $c2 = $op === 'y' ? $end : self::apply($gs['ctm'], $n($k - 4), $n($k - 3));
                    for ($t = 0.25; $t <= 1.0001; $t += 0.25) {
                        $u = 1 - $t;
                        $cur['pts'][] = [
                            $u * $u * $u * $last[0] + 3 * $u * $u * $t * $c1[0] + 3 * $u * $t * $t * $c2[0] + $t * $t * $t * $end[0],
                            $u * $u * $u * $last[1] + 3 * $u * $u * $t * $c1[1] + 3 * $u * $t * $t * $c2[1] + $t * $t * $t * $end[1],
                        ];
                    }
                    $cur['curve'] = true;
                    break;
                case 'h':
                    if ($cur !== null && count($cur['pts'])) $cur['closed'] = true;
                    break;
                case 're':
                    if ($cur !== null) $path[] = $cur;
                    [$x, $y, $w, $h] = [$n(0), $n(1), $n(2), $n(3)];
                    $path[] = ['pts' => [self::apply($gs['ctm'], $x, $y), self::apply($gs['ctm'], $x + $w, $y), self::apply($gs['ctm'], $x + $w, $y + $h), self::apply($gs['ctm'], $x, $y + $h)], 'curve' => false];
                    $cur = null;
                    break;
                case 'S': case 's': $flush('S'); break;
                case 'f': case 'F': case 'f*': $flush('f'); break;
                case 'B': case 'B*': case 'b': case 'b*': $flush('f'); break;
                case 'n': $path = []; $cur = null; break;
                case 'W': case 'W*': break;
                case 'BT': $text['tm'] = $text['tlm'] = [1, 0, 0, 1, 0, 0]; $this->run++; break;
                case 'ET': break;
                case 'Tf':
                    $name = $ops[0] ?? null;
                    $text['font'] = $name instanceof PdfName ? $this->font($res, $name->name) : null;
                    $text['size'] = $n(1);
                    break;
                case 'Tc': $text['tc'] = $n(0); break;
                case 'Tw': $text['tw'] = $n(0); break;
                case 'Tz': $text['th'] = $n(0) / 100; break;
                case 'TL': $text['tl'] = $n(0); break;
                case 'Ts': $text['rise'] = $n(0); break;
                case 'Td':
                    $text['tlm'] = self::mul([1, 0, 0, 1, $n(0), $n(1)], $text['tlm']);
                    $text['tm'] = $text['tlm'];
                    break;
                case 'TD':
                    $text['tl'] = -$n(1);
                    $text['tlm'] = self::mul([1, 0, 0, 1, $n(0), $n(1)], $text['tlm']);
                    $text['tm'] = $text['tlm'];
                    break;
                case 'Tm':
                    $text['tlm'] = $text['tm'] = [$n(0), $n(1), $n(2), $n(3), $n(4), $n(5)];
                    break;
                case 'T*':
                    $text['tlm'] = self::mul([1, 0, 0, 1, 0, -$text['tl']], $text['tlm']);
                    $text['tm'] = $text['tlm'];
                    break;
                case 'Tj': case "'": case '"':
                    if ($op !== 'Tj') {
                        $text['tlm'] = self::mul([1, 0, 0, 1, 0, -$text['tl']], $text['tlm']);
                        $text['tm'] = $text['tlm'];
                    }
                    $s = $ops[count($ops) - 1] ?? null;
                    if (is_array($s) && isset($s['str'])) $this->show($s['str'], $text, $gs);
                    break;
                case 'TJ':
                    foreach ((array) ($ops[0] ?? []) as $item) {
                        if (is_array($item) && isset($item['str'])) $this->show($item['str'], $text, $gs);
                        elseif (is_int($item) || is_float($item)) $text['tm'] = self::mul([1, 0, 0, 1, -$item / 1000 * $text['size'] * $text['th'], 0], $text['tm']);
                    }
                    break;
                case 'Do':
                    $name = $ops[0] ?? null;
                    if (!$name instanceof PdfName) break;
                    $xo = $this->doc->get(((array) $this->doc->get($res['XObject'] ?? []))[$name->name] ?? null);
                    if (!$xo instanceof PdfStream) break;
                    $subtype = $this->doc->name($xo->dict['Subtype'] ?? null);
                    if ($subtype === 'Image') $this->images++;
                    elseif ($subtype === 'Form') {
                        $m = array_map(fn ($x) => (float) $this->doc->get($x), (array) $this->doc->get($xo->dict['Matrix'] ?? [1, 0, 0, 1, 0, 0]));
                        $r = $this->doc->get($xo->dict['Resources'] ?? null);
                        $this->run($this->doc->decode($xo), is_array($r) ? $r : $res, self::mul($m, $gs['ctm']), $depth + 1);
                    }
                    break;
                case 'BI':
                    $p->skipInlineImage();
                    $this->images++;
                    break;
            }
            $ops = [];
        }
    }

    private function show(string $s, array &$text, array $gs): void
    {
        $font = $text['font'];
        if (!$font instanceof PdfFont) return;
        $size = $text['size'];
        foreach ($font->codes($s) as [$code, $ch]) {
            $trm = self::mul([$size * $text['th'], 0, 0, $size, 0, $text['rise']], self::mul($text['tm'], $gs['ctm']));
            $adv = $font->width($code) / 1000;
            $em = sqrt(abs($trm[2] * $trm[2] + $trm[3] * $trm[3]));
            $this->glyphs[] = [
                'font' => $font->base,
                'ch' => $ch,
                'x' => $trm[4],
                'y' => $trm[5],
                'size' => $em,
                'w' => $adv * sqrt($trm[0] * $trm[0] + $trm[1] * $trm[1]),
                'run' => $this->run,
            ];
            $tx = ($adv * $size + $text['tc'] + ($code === 32 && !$font->twoByte ? $text['tw'] : 0)) * $text['th'];
            $text['tm'] = self::mul([1, 0, 0, 1, $tx, 0], $text['tm']);
        }
    }
}
