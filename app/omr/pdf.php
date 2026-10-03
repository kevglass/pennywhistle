<?php
// A small PDF reader: objects, streams, pages, and a content-stream interpreter that
// reports what each page draws (glyphs with their position and size, stroked lines and
// filled shapes). Enough for computer-made PDFs such as MuseScore exports; no rendering.
declare(strict_types=1);

final class PdfRef
{
    public function __construct(public int $num) {}
}

final class PdfName
{
    public function __construct(public string $name) {}
}

final class PdfStream
{
    public function __construct(public array $dict, public string $raw) {}
}

final class PdfError extends Exception {}

final class PdfParser
{
    private int $pos = 0;
    private int $len;

    public function __construct(private string $s, private bool $content = false)
    {
        $this->len = strlen($s);
    }

    public function at(int $pos): self
    {
        $this->pos = $pos;
        return $this;
    }

    public function pos(): int
    {
        return $this->pos;
    }

    /** Skip an inline image (after BI): past its ID data and the closing EI. */
    public function skipInlineImage(): void
    {
        $id = strpos($this->s, 'ID', $this->pos);
        if ($id === false) { $this->pos = $this->len; return; }
        $this->pos = preg_match('/\sEI(?=\s|$)/', $this->s, $m, PREG_OFFSET_CAPTURE, $id + 3) ? $m[0][1] + 3 : $this->len;
    }

    public function eof(): bool
    {
        $this->skipSpace();
        return $this->pos >= $this->len;
    }

    private function skipSpace(): void
    {
        while ($this->pos < $this->len) {
            $c = $this->s[$this->pos];
            if ($c === '%') {
                while ($this->pos < $this->len && $this->s[$this->pos] !== "\n" && $this->s[$this->pos] !== "\r") $this->pos++;
            } elseif (strpos(" \t\r\n\f\0", $c) !== false) {
                $this->pos++;
            } else {
                break;
            }
        }
    }

    /**
     * The next value. In content streams, bare words come back as ['op' => word].
     * Returns null at the end of input; PDF null comes back as null too, which is fine here.
     */
    public function value(): mixed
    {
        $this->skipSpace();
        if ($this->pos >= $this->len) return null;
        $s = $this->s;
        $c = $s[$this->pos];
        if ($c === '/') {
            $start = ++$this->pos;
            while ($this->pos < $this->len && strpos(" \t\r\n\f\0/[]<>(){}%", $s[$this->pos]) === false) $this->pos++;
            $name = substr($s, $start, $this->pos - $start);
            return new PdfName(str_contains($name, '#') ? preg_replace_callback('/#([0-9A-Fa-f]{2})/', fn ($m) => chr(hexdec($m[1])), $name) : $name);
        }
        if ($c === '<' && ($s[$this->pos + 1] ?? '') === '<') {
            $this->pos += 2;
            $dict = [];
            for (;;) {
                $this->skipSpace();
                if ($this->pos >= $this->len) break;
                if ($s[$this->pos] === '>' && ($s[$this->pos + 1] ?? '') === '>') { $this->pos += 2; break; }
                $key = $this->value();
                if (!$key instanceof PdfName) continue;
                $dict[$key->name] = $this->value();
            }
            if (!$this->content) {
                // A stream follows its dictionary.
                $save = $this->pos;
                $this->skipSpace();
                if (substr($s, $this->pos, 6) === 'stream') {
                    $this->pos += 6;
                    if (($s[$this->pos] ?? '') === "\r") $this->pos++;
                    if (($s[$this->pos] ?? '') === "\n") $this->pos++;
                    return new PdfStream($dict, $this->pos . ''); // raw data is cut out by PdfDoc
                }
                $this->pos = $save;
            }
            return $dict;
        }
        if ($c === '<') {
            $end = strpos($s, '>', $this->pos);
            if ($end === false) $end = $this->len;
            $hex = preg_replace('/[^0-9A-Fa-f]/', '', substr($s, $this->pos + 1, $end - $this->pos - 1));
            $this->pos = $end + 1;
            if (strlen($hex) % 2) $hex .= '0';
            return ['str' => (string) hex2bin($hex)];
        }
        if ($c === '(') return ['str' => $this->literal()];
        if ($c === '[') {
            $this->pos++;
            $arr = [];
            for (;;) {
                $this->skipSpace();
                if ($this->pos >= $this->len) break;
                if ($s[$this->pos] === ']') { $this->pos++; break; }
                $arr[] = $this->value();
            }
            return $arr;
        }
        if ($c === ']' || $c === '>' || $c === ')' || $c === '{' || $c === '}') {
            $this->pos++;
            return $this->value();
        }
        // number, reference, keyword
        $start = $this->pos;
        while ($this->pos < $this->len && strpos(" \t\r\n\f\0/[]<>(){}%", $s[$this->pos]) === false) $this->pos++;
        $word = substr($s, $start, $this->pos - $start);
        if (is_numeric($word)) {
            if (!$this->content && ctype_digit($word)) {
                // "12 0 R" is a reference
                if (preg_match('/\G\s+(\d+)\s+R(?![A-Za-z])/', $s, $m, 0, $this->pos)) {
                    $this->pos += strlen($m[0]);
                    return new PdfRef((int) $word);
                }
            }
            return $word + 0;
        }
        if ($word === 'true') return true;
        if ($word === 'false') return false;
        if ($word === 'null' && !$this->content) return null;
        return ['op' => $word];
    }

    private function literal(): string
    {
        $s = $this->s;
        $this->pos++;
        $out = '';
        $depth = 1;
        while ($this->pos < $this->len) {
            $c = $s[$this->pos++];
            if ($c === '\\') {
                $n = $s[$this->pos++] ?? '';
                $map = ['n' => "\n", 'r' => "\r", 't' => "\t", 'b' => "\x08", 'f' => "\f", '(' => '(', ')' => ')', '\\' => '\\'];
                if (isset($map[$n])) $out .= $map[$n];
                elseif ($n >= '0' && $n <= '7') {
                    $oct = $n;
                    while (strlen($oct) < 3 && ($s[$this->pos] ?? '') >= '0' && ($s[$this->pos] ?? '') <= '7') $oct .= $s[$this->pos++];
                    $out .= chr(octdec($oct) & 255);
                } elseif ($n === "\r") {
                    if (($s[$this->pos] ?? '') === "\n") $this->pos++;
                }
                elseif ($n !== "\n") $out .= $n;
            } elseif ($c === '(') {
                $depth++;
                $out .= $c;
            } elseif ($c === ')') {
                if (--$depth === 0) break;
                $out .= $c;
            } else {
                $out .= $c;
            }
        }
        return $out;
    }
}

final class PdfDoc
{
    /** @var array<int, mixed> */
    private array $objects = [];
    private array $streamCache = [];
    public array $info = [];
    private ?array $trailer = null;

    public function __construct(private string $data)
    {
        if (!str_starts_with(ltrim(substr($data, 0, 1024)), '%PDF') && !str_contains(substr($data, 0, 1024), '%PDF')) throw new PdfError('Not a PDF file');
        $this->scanObjects();
        $this->expandObjectStreams();
        $info = $this->get($this->trailer['Info'] ?? null);
        if (is_array($info)) {
            foreach ($info as $k => $v) {
                $v = $this->get($v);
                if (is_array($v) && isset($v['str'])) $this->info[$k] = self::textString($v['str']);
            }
        }
    }

    /** Find every "n g obj" in file order (later copies win, as with incremental updates). */
    private function scanObjects(): void
    {
        $d = $this->data;
        preg_match_all('/(?<![0-9])(\d+)\s+(\d+)\s+obj\b/', $d, $m, PREG_OFFSET_CAPTURE);
        $p = new PdfParser($d);
        foreach ($m[0] as $i => $whole) {
            $num = (int) $m[1][$i][0];
            $start = $whole[1] + strlen($whole[0]);
            try {
                $val = $p->at($start)->value();
            } catch (Throwable) {
                continue;
            }
            if ($val instanceof PdfStream) {
                $from = (int) $val->raw;
                $length = $val->dict['Length'] ?? null;
                if ($length instanceof PdfRef) $length = null; // resolved below once all objects are known
                $end = is_int($length) && $from + $length <= strlen($d) && preg_match('/^\s*endstream/', substr($d, $from + $length, 30)) ? $from + $length : null;
                if ($end === null) {
                    $end = strpos($d, 'endstream', $from);
                    if ($end === false) continue;
                    // trim the EOL before endstream
                    if ($end > $from && $d[$end - 1] === "\n") $end--;
                    if ($end > $from && $d[$end - 1] === "\r") $end--;
                }
                $val = new PdfStream($val->dict, substr($d, $from, $end - $from));
            }
            $this->objects[$num] = $val;
        }
        // trailer: the xref stream's dictionary and/or classic trailer dictionaries (last wins)
        $this->trailer = [];
        foreach ($this->objects as $o) {
            if ($o instanceof PdfStream && $this->name($o->dict['Type'] ?? null) === 'XRef') $this->trailer = array_merge($this->trailer, $o->dict);
        }
        if (preg_match_all('/trailer\s*(<<)/', $d, $t, PREG_OFFSET_CAPTURE)) {
            foreach ($t[1] as $hit) {
                $tr = $p->at($hit[1])->value();
                if (is_array($tr)) $this->trailer = array_merge($this->trailer, $tr);
            }
        }
    }

    private function expandObjectStreams(): void
    {
        foreach ($this->objects as $o) {
            if (!$o instanceof PdfStream || !(($o->dict['Type'] ?? null) instanceof PdfName) || $o->dict['Type']->name !== 'ObjStm') continue;
            $data = $this->decode($o);
            $n = (int) $this->get($o->dict['N'] ?? 0);
            $first = (int) $this->get($o->dict['First'] ?? 0);
            $nums = preg_split('/\s+/', trim(substr($data, 0, $first)));
            $p = new PdfParser($data);
            for ($i = 0; $i < $n; $i++) {
                $num = (int) ($nums[$i * 2] ?? -1);
                $off = (int) ($nums[$i * 2 + 1] ?? 0);
                if ($num < 0 || isset($this->objects[$num])) continue;
                try {
                    $this->objects[$num] = $p->at($first + $off)->value();
                } catch (Throwable) {
                }
            }
        }
    }

    public function get(mixed $v): mixed
    {
        $guard = 0;
        while ($v instanceof PdfRef && $guard++ < 32) $v = $this->objects[$v->num] ?? null;
        return $v;
    }

    public function name(mixed $v): ?string
    {
        $v = $this->get($v);
        return $v instanceof PdfName ? $v->name : null;
    }

    public static function textString(string $s): string
    {
        if (str_starts_with($s, "\xFE\xFF")) return mb_convert_encoding(substr($s, 2), 'UTF-8', 'UTF-16BE');
        if (str_starts_with($s, "\xFF\xFE")) return mb_convert_encoding(substr($s, 2), 'UTF-8', 'UTF-16LE');
        return mb_convert_encoding($s, 'UTF-8', 'ISO-8859-1');
    }

    /** Decoded stream data (Flate, with PNG predictors; other filters are passed through). */
    public function decode(PdfStream $st): string
    {
        $key = spl_object_id($st);
        if (isset($this->streamCache[$key])) return $this->streamCache[$key];
        $data = $st->raw;
        $filters = $this->get($st->dict['Filter'] ?? null);
        $params = $this->get($st->dict['DecodeParms'] ?? null);
        $filters = $filters instanceof PdfName ? [$filters] : (is_array($filters) ? $filters : []);
        $params = is_array($params) && array_is_list($params) ? $params : [$params];
        foreach ($filters as $i => $f) {
            $f = $this->name($f);
            if ($f === 'FlateDecode' || $f === 'Fl') {
                $out = @gzuncompress($data);
                if ($out === false) $out = @gzinflate(substr($data, 2));
                if ($out === false) $out = self::inflatePartial($data);
                $data = $out;
                $parm = $this->get($params[$i] ?? null);
                if (is_array($parm) && (int) $this->get($parm['Predictor'] ?? 1) >= 10) {
                    $data = self::unpredict($data, (int) $this->get($parm['Columns'] ?? 1));
                }
            } else {
                break; // image filters etc.: not needed
            }
        }
        return $this->streamCache[$key] = $data;
    }

    private static function inflatePartial(string $data): string
    {
        $ctx = @inflate_init(ZLIB_ENCODING_DEFLATE);
        if ($ctx === false) return '';
        $out = @inflate_add($ctx, $data, ZLIB_SYNC_FLUSH);
        return $out === false ? '' : $out;
    }

    private static function unpredict(string $data, int $cols): string
    {
        $out = '';
        $prev = str_repeat("\0", $cols);
        $row = $cols + 1;
        for ($i = 0; $i + $row <= strlen($data); $i += $row) {
            $type = ord($data[$i]);
            $line = substr($data, $i + 1, $cols);
            $cur = '';
            for ($j = 0; $j < $cols; $j++) {
                $left = $j > 0 ? ord($cur[$j - 1]) : 0;
                $up = ord($prev[$j]);
                $x = ord($line[$j]);
                $cur .= chr(match ($type) {
                    1 => $x + $left,
                    2 => $x + $up,
                    3 => $x + intdiv($left + $up, 2),
                    4 => $x + self::paeth($left, $up, $j > 0 ? ord($prev[$j - 1]) : 0),
                    default => $x,
                } & 255);
            }
            $out .= $cur;
            $prev = $cur;
        }
        return $out;
    }

    private static function paeth(int $a, int $b, int $c): int
    {
        $p = $a + $b - $c;
        $pa = abs($p - $a);
        $pb = abs($p - $b);
        $pc = abs($p - $c);
        return $pa <= $pb && $pa <= $pc ? $a : ($pb <= $pc ? $b : $c);
    }

    /** Page dictionaries in order, each with inherited Resources / MediaBox filled in. */
    public function pages(): array
    {
        $root = $this->get($this->trailer['Root'] ?? null);
        if (!is_array($root)) {
            foreach ($this->objects as $o) if (is_array($o) && $this->name($o['Type'] ?? null) === 'Catalog') { $root = $o; break; }
        }
        $out = [];
        $walk = function ($node, array $inherit, int $depth) use (&$walk, &$out) {
            $node = $this->get($node);
            if (!is_array($node) || $depth > 64) return;
            foreach (['Resources', 'MediaBox', 'Rotate'] as $k) if (isset($node[$k])) $inherit[$k] = $node[$k];
            if ($this->name($node['Type'] ?? null) === 'Pages' || isset($node['Kids'])) {
                foreach ((array) $this->get($node['Kids'] ?? []) as $kid) $walk($kid, $inherit, $depth + 1);
            } else {
                $out[] = array_merge($node, $inherit);
            }
        };
        if (is_array($root)) $walk($root['Pages'] ?? null, [], 0);
        return $out;
    }

    public function pageContent(array $page): string
    {
        $c = $this->get($page['Contents'] ?? null);
        $parts = $c instanceof PdfStream ? [$c] : (is_array($c) ? array_map(fn ($x) => $this->get($x), $c) : []);
        $out = '';
        foreach ($parts as $p) if ($p instanceof PdfStream) $out .= $this->decode($p) . "\n";
        return $out;
    }
}
