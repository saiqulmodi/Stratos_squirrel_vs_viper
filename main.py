import sys
import math
import random
import struct
import io
import asyncio
from array import array
import pygame

GAME_NAME = "Survival - Mongoose vs Viper"
GAME_VERSION = "v15 MOBILE"

# ---------------------------------------------------------
# 1. VIEWPORT & FULLSCREEN CONFIGURATION
# ---------------------------------------------------------
WIDTH = 1280
HEIGHT = 720

_last_fit = None
_portrait = False   # phone held upright (taller than wide)

def detect_mobile():
    """True on phones/tablets (finger as the main pointer) or with ?mobile in the link.
    Desktop tests can force it with the SSV_MOBILE=1 environment variable."""
    import os
    if os.environ.get("SSV_MOBILE") == "1":
        return True
    if sys.platform != "emscripten":
        return False
    try:
        import platform
        win = platform.window
        if "mobile" in str(win.location.search).lower() or "/mobile" in str(win.location.pathname).lower():
            return True
        return bool(win.matchMedia("(pointer: coarse)").matches)
    except Exception:
        return False

def fit_canvas_to_browser():
    """Browser only: scale the whole 1280x720 game to fit the window without cropping.

    Keeps the 16:9 shape (black bars fill any spare space) and works with any
    Windows display scaling (100%, 125%, 150%...). Called regularly because the
    pygbag loader resizes the canvas itself and would otherwise cut off the edges.
    """
    global _last_fit, _portrait
    if sys.platform != "emscripten":
        return
    try:
        import platform
        win = platform.window
        vw = int(win.innerWidth)
        vh = int(win.innerHeight)
        _portrait = vh > vw
        scale = min(vw / WIDTH, vh / HEIGHT)
        w = int(WIDTH * scale)
        h = int(HEIGHT * scale)
        left = (vw - w) // 2
        top = (vh - h) // 2
        style = win.canvas.style
        # Re-apply if the window changed OR the loader overwrote our size
        if _last_fit == (vw, vh) and style.width == f"{w}px" and style.height == f"{h}px":
            return
        _last_fit = (vw, vh)
        body = win.document.body.style
        body.margin = "0"
        body.padding = "0"
        body.overflow = "hidden"
        body.backgroundColor = "#05060d"
        style.position = "fixed"
        style.inset = "auto"
        style.right = "auto"
        style.bottom = "auto"
        style.margin = "0"
        style.padding = "0"
        style.border = "none"
        style.display = "block"
        style.left = f"{left}px"
        style.top = f"{top}px"
        style.width = f"{w}px"
        style.height = f"{h}px"
    except Exception:
        pass

SHOT_SPEED = 12.0      # Squirrel laser and viper venom travel at the same speed
HIT_RADIUS = 20        # Same hit size for squirrel body and viper head
CONTACT_RADIUS = 30    # Squirrel and viper touching = both take a hit
SHARD_BOOST = 1.25         # Picking up a shard: +25% attack...
SHARD_BOOST_FRAMES = 600   # ...for 10 seconds (60 FPS), for whoever grabs it
SHARD_SPAWN_FRAMES = 420   # A new shard appears every 7 seconds (max 2 on screen)

# ---------------------------------------------------------
# 2. LOCALSTORAGE HIGH SCORE
# ---------------------------------------------------------
def get_stored_high_score():
    if sys.platform == "emscripten":
        try:
            import platform
            val = platform.window.localStorage.getItem("neontail_hiscore")
            return int(val) if val else 0
        except Exception:
            return 0
    return 0

def save_stored_high_score(score):
    if sys.platform == "emscripten":
        try:
            import platform
            platform.window.localStorage.setItem("neontail_hiscore", str(score))
        except Exception:
            pass

# ---------------------------------------------------------
# 3. CLEAN MUSICAL AUDIO (16-bit PCM, no white noise)
# ---------------------------------------------------------
audio_muted = False
SFX_RATE = 22050

def mixer_sound(samples, rate):
    """Turns mono samples (-1.0..1.0) into a Sound in the mixer's OWN raw format.

    pygame's Sound(buffer=...) plays bytes as raw data in whatever format the mixer
    was opened with (rate, sample type, channels). Handing it a WAV file or a
    different format makes it play the header as noise, at the wrong speed/pitch,
    or (in the browser) as pure static. So we match the mixer exactly.
    """
    init = pygame.mixer.get_init()
    if not init:
        return None

    # Preferred: a real WAV file object. SDL decodes the header and converts to
    # whatever format the mixer uses (desktop or browser), so nothing is guessed.
    try:
        pcm = array("h", (int(32767 * max(-1.0, min(1.0, v))) for v in samples)).tobytes()
        wav = (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt "
               + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
               + b"data" + struct.pack("<I", len(pcm)) + pcm)
        return pygame.mixer.Sound(file=io.BytesIO(wav))
    except Exception:
        pass

    # Fallback: raw bytes in the mixer's own format
    out_rate, fmt, channels = init

    # Resample (linear) from our render rate to the mixer's rate
    if out_rate != rate:
        n_out = max(1, int(len(samples) * out_rate / rate))
        step = rate / out_rate
        res = []
        last = len(samples) - 1
        for i in range(n_out):
            pos = i * step
            j = int(pos)
            if j >= last:
                res.append(samples[last])
            else:
                f = pos - j
                res.append(samples[j] * (1.0 - f) + samples[j + 1] * f)
        samples = res

    if fmt in (32, -32):     # 32-bit float (pygame reports it as -32)
        typecode, conv = "f", (lambda v: v)
    elif fmt == 16:          # 16-bit unsigned
        typecode, conv = "H", (lambda v: int(v * 32767) + 32768)
    elif fmt == 8:           # 8-bit unsigned
        typecode, conv = "B", (lambda v: int(v * 127) + 128)
    elif fmt == -8:          # 8-bit signed
        typecode, conv = "b", (lambda v: int(v * 127))
    else:                    # -16: 16-bit signed (the usual one)
        typecode, conv = "h", (lambda v: int(v * 32767))

    data = array(typecode)
    for v in samples:
        c = conv(v)
        for _ in range(channels):
            data.append(c)
    try:
        return pygame.mixer.Sound(buffer=data.tobytes())
    except Exception:
        return None

def render_sound(duration, fn, rate=SFX_RATE, peak=0.6):
    """Renders fn(t) into a normalised, click-free sound (short fade in/out, never clips)."""
    n = max(1, int(rate * duration))
    buf = [fn(i / rate) for i in range(n)]
    top = max(1e-6, max(abs(v) for v in buf))
    scale = peak / top
    fade_in = max(1, int(rate * 0.004))
    fade_out = max(1, int(rate * 0.015))
    out = []
    for i, v in enumerate(buf):
        g = 1.0
        if i < fade_in:
            g = i / fade_in
        elif i > n - fade_out:
            g = (n - i) / fade_out
        out.append(max(-1.0, min(1.0, v * scale * g)))
    return mixer_sound(out, rate)

TWO_PI = 2 * math.pi

def voice(name, f, t):
    """One musical note of the given instrument, t seconds after it starts."""
    w = TWO_PI * t
    if name == "bell":
        return (math.sin(w * f) + 0.35 * math.sin(w * f * 2.76) * math.exp(-t * 10)
                + 0.12 * math.sin(w * f * 5.4) * math.exp(-t * 22)) * math.exp(-t * 6)
    if name == "pluck":
        return (math.sin(w * f) + 0.3 * math.sin(w * f * 2) + 0.12 * math.sin(w * f * 3)) * math.exp(-t * 13)
    if name == "pad":
        return (math.sin(w * f) + 0.6 * math.sin(w * f * 1.004) + 0.2 * math.sin(w * f * 2)) * min(1.0, t * 40) * math.exp(-t * 4)
    if name == "marimba":
        return (math.sin(w * f) + 0.5 * math.sin(w * f * 4) * math.exp(-t * 40)) * math.exp(-t * 10)
    if name == "reed":
        vib = 0.25 * math.sin(w * 6)
        return (math.sin(w * f + vib) + 0.3 * math.sin(3 * (w * f + vib)) + 0.12 * math.sin(5 * (w * f + vib))) * min(1.0, t * 60) * math.exp(-t * 7)
    if name == "fm":
        return math.sin(w * f + 2.0 * math.exp(-t * 8) * math.sin(w * f * 2)) * math.exp(-t * 7)
    if name == "drum":
        phase = TWO_PI * (f * t + f * 2.0 * (1.0 - math.exp(-t * 30)) / 30.0)
        return math.sin(phase) * math.exp(-t * 16)
    return math.sin(w * f) * math.exp(-t * 8)

# Each game mode has its own musical scale (semitones)
MODE_SCALES = {
    1: [0, 2, 4, 7, 9],           # Solo vs AI: bright pentatonic
    2: [0, 2, 4, 5, 7, 9, 11],    # Dual squirrels vs AI: major
    3: [0, 2, 3, 5, 7, 8, 10],    # Squirrel vs Viper: minor (tense)
}

# ...and its own key, so the same tool never sounds the same in two modes
MODE_KEYS = {1: 0, 2: 5, 3: -3}

# Every attacking tool plays its own little tune: (instrument, base Hz, [(scale step, seconds), ...])
ATTACK_TUNES = {
    "sq1_shot":  ("bell",    523.25, [(0, 0.05), (4, 0.09)]),                          # P1 squirrel laser
    "sq1_nova":  ("pad",     392.00, [(0, 0.05), (2, 0.05), (4, 0.05), (7, 0.20)]),    # P1 squirrel nova
    "sq2_shot":  ("pluck",   587.33, [(2, 0.05), (5, 0.09)]),                          # P2 squirrel blaster
    "sq2_nova":  ("marimba", 440.00, [(7, 0.05), (5, 0.05), (3, 0.05), (0, 0.20)]),    # P2 squirrel nova
    "vp_spit":   ("reed",    196.00, [(1, 0.07), (0, 0.11)]),                          # viper venom spit
    "vp_burst":  ("fm",      146.83, [(0, 0.07), (2, 0.07), (4, 0.18)]),               # viper venom burst
    "vp_bite":   ("drum",    150.00, [(0, 0.14)]),                                     # squirrel/viper clash
}
# In Squirrel vs Viper the human-controlled viper gets its own instruments
PVP_INSTRUMENTS = {"vp_spit": "marimba", "vp_burst": "bell", "vp_bite": "drum"}

def sound_tier(level):
    """Attack tunes move up a step every 3 levels (0-11)."""
    return max(0, min(11, (max(1, level) - 1) // 3))

def render_tune(instrument, base, notes, scale, transpose, tempo):
    starts = []
    t0 = 0.0
    for step, dur in notes:
        semi = scale[step % len(scale)] + 12 * (step // len(scale)) + transpose
        starts.append((t0, base * 2 ** (semi / 12.0)))
        t0 += dur * tempo
    ring = 0.08   # short tail so rapid fire never blends into a continuous drone
    total = min(0.35, t0 + ring)

    def fn(t):
        v = 0.0
        for st, fr in starts:
            lt = t - st
            if 0.0 <= lt < total:
                v += voice(instrument, fr, lt)
        return v

    return render_sound(total, fn)

_attack_sfx_cache = {}

def get_attack_sfx(tool, mode, level):
    """Unique tune per (attack tool, game mode, level tier), built once and cached."""
    tier = sound_tier(level)
    key = (tool, mode, tier)
    if key not in _attack_sfx_cache:
        instrument, base, notes = ATTACK_TUNES[tool]
        if mode == 3 and tool in PVP_INSTRUMENTS:
            instrument = PVP_INSTRUMENTS[tool]
        try:
            _attack_sfx_cache[key] = render_tune(instrument, base, notes, MODE_SCALES.get(mode, MODE_SCALES[1]),
                                                 transpose=tier + MODE_KEYS.get(mode, 0), tempo=max(0.7, 1.0 - tier * 0.025))
        except Exception:
            _attack_sfx_cache[key] = None
    return _attack_sfx_cache[key]

def play_sfx(sfx):
    """Only attack actions make sound. A repeat of the same attack restarts its sound instead of stacking copies."""
    if sfx and not audio_muted:
        try:
            sfx.stop()
            sfx.play()
        except Exception:
            pass

def stop_all_sound():
    try:
        pygame.mixer.stop()
    except Exception:
        pass

# ---------------------------------------------------------
# 4. PROJECTILES, PARTICLES & ENERGY SHARDS
# ---------------------------------------------------------
class Projectile:
    def __init__(self, x, y, tx, ty, damage=40, color=(0, 255, 230), is_hostile=False, speed=SHOT_SPEED, owner=None):
        self.x = float(x)
        self.y = float(y)
        angle = math.atan2(ty - y, tx - x)
        self.speed = speed
        self.vx = math.cos(angle) * self.speed
        self.vy = math.sin(angle) * self.speed
        self.damage = damage
        self.color = color
        self.is_hostile = is_hostile
        self.owner = owner
        self.alive = True

    def update(self):
        self.x += self.vx
        self.y += self.vy
        if self.x < -30 or self.x > WIDTH + 30 or self.y < -30 or self.y > HEIGHT + 30:
            self.alive = False

    def draw(self, surface):
        # A drop of venom with a few small droplets trailing behind it
        for k, r in ((2.2, 2), (1.3, 3)):
            pygame.draw.circle(surface, (150, 170, 40), (int(self.x - self.vx * k), int(self.y - self.vy * k)), r)
        pygame.draw.circle(surface, (60, 70, 20), (int(self.x), int(self.y)), 6)
        pygame.draw.circle(surface, (200, 215, 70), (int(self.x), int(self.y)), 5)
        pygame.draw.circle(surface, (245, 250, 190), (int(self.x - 1), int(self.y - 2)), 2)

class Particle:
    def __init__(self, x, y, color):
        self.x = float(x)
        self.y = float(y)
        angle = random.uniform(0, math.pi * 2)
        speed = random.uniform(2.0, 6.0)
        self.vx = math.cos(angle) * speed
        self.vy = math.sin(angle) * speed
        self.life = random.randint(14, 24)
        self.color = color

    def update(self):
        self.x += self.vx
        self.y += self.vy
        self.life -= 1

    def draw(self, surface):
        if self.life > 0:
            pygame.draw.circle(surface, self.color, (int(self.x), int(self.y)), max(1, self.life // 5))

BURST_FRAMES = 48       # ~0.8 s at 60 FPS: a beaten viper's pieces fly apart and fade before anything reappears
BODY_HIT_RADIUS = 14    # body/tail segments are a slightly smaller target than the head (HIT_RADIUS)


class BurstPiece:
    """One neon piece of a beaten viper (head or a body/tail segment). Silent, cartoon, no gore."""
    def __init__(self, x, y, radius, outer, inner, cx, cy):
        self.x, self.y = float(x), float(y)
        ang = math.atan2(y - cy, x - cx) + random.uniform(-0.6, 0.6) if (x, y) != (cx, cy) else random.uniform(0, math.pi * 2)
        speed = random.uniform(2.5, 7.0)
        self.vx, self.vy = math.cos(ang) * speed, math.sin(ang) * speed
        self.radius = radius
        self.outer, self.inner = outer, inner
        self.life = BURST_FRAMES
        self.spin = random.uniform(0, math.pi * 2)
        self.spin_speed = random.uniform(-0.35, 0.35)

    def update(self):
        self.x += self.vx
        self.y += self.vy
        self.vx *= 0.94
        self.vy *= 0.94
        self.spin += self.spin_speed
        self.life -= 1

    def draw(self, surface):
        if self.life <= 0:
            return
        r = max(1, int(self.radius * (0.4 + 0.6 * self.life / BURST_FRAMES)))
        # a small wedge-cut disc so each piece looks like a broken shard that tumbles
        pts = [(self.x + math.cos(self.spin + k * 2.1) * r, self.y + math.sin(self.spin + k * 2.1) * r) for k in range(3)]
        pygame.draw.polygon(surface, self.outer, pts)
        pygame.draw.circle(surface, self.inner, (int(self.x), int(self.y)), max(1, r // 2))


class BurstFlash:
    """Quick white ring at the head when a viper is beaten."""
    def __init__(self, x, y):
        self.x, self.y = x, y
        self.life = 14

    def update(self):
        self.life -= 1

    def draw(self, surface):
        if self.life > 0:
            pygame.draw.circle(surface, (255, 255, 255), (int(self.x), int(self.y)), int(18 + (14 - self.life) * 3), 3)


class Shard:
    def __init__(self, x, y):
        self.x = float(max(40, min(WIDTH - 40, x)))
        self.y = float(max(40, min(HEIGHT - 40, y)))
        self.life = 360
        self.pulse = random.uniform(0, math.pi * 2)

    def update(self):
        self.life -= 1
        self.pulse += 0.12

    def draw(self, surface):
        # A bird's egg lying on the ground (power-up): rocks gently
        x, y = int(self.x), int(self.y + math.sin(self.pulse) * 1.5)
        pygame.draw.ellipse(surface, (34, 26, 17), (x - 8, y + 4, 18, 7))
        pygame.draw.ellipse(surface, (60, 52, 40), (x - 8, y - 11, 16, 21))
        pygame.draw.ellipse(surface, (238, 230, 205), (x - 7, y - 10, 14, 19))
        for dx, dy in ((-3, -5), (2, -2), (-1, 3), (3, 4), (-4, 1)):
            pygame.draw.circle(surface, (150, 120, 80), (x + dx, y + dy), 1)
        pygame.draw.circle(surface, (255, 255, 245), (x - 3, y - 6), 2)

# ---------------------------------------------------------
# 5. SHARED FIGHTER STATS (squirrel and viper always identical)
# ---------------------------------------------------------
def _glow_shape(bd, blobs, line, fill):
    """Draw a smooth body made of overlapping circles: faint fill plus one neon outline."""
    shape = pygame.Surface((WIDTH, HEIGHT), pygame.SRCALPHA)
    for (x, y), r in blobs:
        pygame.draw.circle(shape, (255, 255, 255, 255), (int(x), int(y)), int(r))
    mask = pygame.mask.from_surface(shape)
    for comp in mask.connected_components():
        pts = comp.outline(2)
        if len(pts) > 2:
            pygame.draw.polygon(bd, fill, pts)
            pygame.draw.lines(bd, line, True, pts, 3)


def _chain(points, r0, r1, step=6):
    """Circles along a path, radius going from r0 to r1 (a tapering body or tail)."""
    out = []
    for i in range(len(points) - 1):
        (x0, y0), (x1, y1) = points[i], points[i + 1]
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
        for k in range(n):
            t = (i + k / n) / (len(points) - 1)
            out.append(((x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n), r0 + (r1 - r0) * t))
    out.append((points[-1], r1))
    return out


def make_holes():
    """Fixed snake holes spread over the arena (clear of the HUD at the top and the level bar)."""
    rnd = random.Random(11)
    holes = []
    tries = 0
    while len(holes) < HOLE_COUNT and tries < 5000:
        tries += 1
        x, y = rnd.randint(90, WIDTH - 90), rnd.randint(150, HEIGHT - 120)
        if all(math.hypot(x - hx, y - hy) > 170 for hx, hy in holes):
            holes.append((x, y))
    return holes


def make_ground():
    """The arena is real ground (user, 2026-10-10): dry earth with soil patches, cracks, pebbles,
    grass tufts and dry leaves. Drawn once (fixed seed, same every game) and blitted every frame."""
    rnd = random.Random(7)
    g = pygame.Surface((WIDTH, HEIGHT))
    g.fill((62, 49, 34))
    patches = pygame.Surface((WIDTH, HEIGHT), pygame.SRCALPHA)
    for _ in range(140):                                         # darker and lighter soil patches
        w, h = rnd.randint(60, 260), rnd.randint(30, 140)
        col = rnd.choice([(48, 37, 25, 60), (82, 66, 45, 50), (72, 60, 40, 45), (40, 32, 22, 55)])
        pygame.draw.ellipse(patches, col, (rnd.randint(-80, WIDTH), rnd.randint(-60, HEIGHT), w, h))
    g.blit(patches, (0, 0))
    for _ in range(2600):                                        # fine grains of dirt
        c = rnd.randint(-14, 14)
        g.set_at((rnd.randrange(WIDTH), rnd.randrange(HEIGHT)), (62 + c, 49 + c, 34 + c))
    for _ in range(14):                                          # cracks in the dry earth
        x, y = rnd.randint(0, WIDTH), rnd.randint(0, HEIGHT)
        ang = rnd.uniform(0, math.tau)
        pts = [(x, y)]
        for _ in range(rnd.randint(4, 8)):
            ang += rnd.uniform(-0.8, 0.8)
            x += math.cos(ang) * rnd.randint(10, 26)
            y += math.sin(ang) * rnd.randint(10, 26)
            pts.append((x, y))
        pygame.draw.lines(g, (38, 29, 19), False, pts, 2)
    for _ in range(170):                                         # pebbles with a lit top edge
        x, y, r = rnd.randint(0, WIDTH), rnd.randint(0, HEIGHT), rnd.randint(2, 6)
        shade = rnd.randint(90, 135)
        pygame.draw.ellipse(g, (30, 24, 16), (x - r + 1, y - r // 2 + 2, r * 2, r + 2))
        pygame.draw.ellipse(g, (shade, shade - 8, shade - 20), (x - r, y - r // 2, r * 2, r + 1))
        pygame.draw.line(g, (shade + 40, shade + 32, shade + 18), (x - r // 2, y - r // 2 + 1), (x + r // 3, y - r // 2 + 1), 1)
    for _ in range(95):                                          # tufts of grass
        x, y = rnd.randint(0, WIDTH), rnd.randint(0, HEIGHT)
        for _ in range(rnd.randint(5, 11)):
            ang = -math.pi / 2 + rnd.uniform(-0.9, 0.9)
            ln = rnd.randint(6, 16)
            col = rnd.choice([(92, 112, 46), (118, 128, 58), (140, 132, 70), (76, 96, 40)])
            bx = x + rnd.randint(-5, 5)
            pygame.draw.line(g, col, (bx, y), (bx + math.cos(ang) * ln, y + math.sin(ang) * ln), 2)
    for _ in range(30):                                          # dry leaves
        x, y = rnd.randint(0, WIDTH), rnd.randint(0, HEIGHT)
        col = rnd.choice([(128, 84, 38), (150, 108, 50), (106, 70, 34)])
        pygame.draw.ellipse(g, col, (x, y, rnd.randint(8, 13), rnd.randint(4, 6)))
        pygame.draw.line(g, (70, 46, 22), (x + 1, y + 2), (x + 10, y + 3), 1)

    def grass_clump(cx, cy, blades, tall):
        for _ in range(blades):
            bx, by = cx + rnd.randint(-14, 14), cy + rnd.randint(-5, 5)
            ang = -math.pi / 2 + rnd.uniform(-0.7, 0.7)
            ln = rnd.randint(tall // 2, tall)
            col = rnd.choice([(86, 108, 42), (108, 124, 52), (130, 128, 64), (70, 92, 38), (150, 140, 74)])
            pygame.draw.line(g, (40, 50, 22), (bx + 1, by + 1), (bx + 1 + math.cos(ang) * ln, by + 1 + math.sin(ang) * ln), 2)
            pygame.draw.line(g, col, (bx, by), (bx + math.cos(ang) * ln, by + math.sin(ang) * ln), 2)

    for _ in range(26):                                          # tall grass clumps
        grass_clump(rnd.randint(0, WIDTH), rnd.randint(0, HEIGHT), rnd.randint(14, 24), 26)
    for hx, hy in HOLES:                                         # snake holes: dark burrow, dug-out dirt rim
        pygame.draw.ellipse(g, (96, 78, 54), (hx - 30, hy - 17, 60, 34))
        pygame.draw.ellipse(g, (78, 62, 42), (hx - 26, hy - 14, 52, 28))
        pygame.draw.ellipse(g, (28, 20, 13), (hx - 20, hy - 11, 40, 22))
        pygame.draw.ellipse(g, (10, 7, 5), (hx - 15, hy - 7, 30, 15))
        for _ in range(5):                                       # loose dirt clods on the rim
            a = rnd.uniform(math.pi * 0.9, math.pi * 2.1)
            pygame.draw.circle(g, (112, 92, 64), (int(hx + math.cos(a) * 30), int(hy + math.sin(a) * 17)), rnd.randint(2, 4))
        grass_clump(hx + rnd.choice((-34, 34)), hy - 10, 10, 22)
    return g


def make_backdrop():
    """Faint neon mongoose and viper facing off behind the arena (user, 2026-10-09).
    Drawn once onto a see-through surface and blitted under the grid every frame."""
    bd = pygame.Surface((WIDTH, HEIGHT), pygame.SRCALPHA)
    mong = (255, 170, 60, 80)        # mongoose: warm amber
    mong_fill = (255, 170, 60, 20)
    vip = (80, 255, 140, 80)         # viper: toxic green
    vip_fill = (80, 255, 140, 20)

    # --- mongoose, left, facing right: bushy tail, long low body, raised head ---
    blobs = _chain([(60, 600), (110, 560), (180, 535), (240, 525)], 6, 26)        # tail, thin tip to thick base
    blobs += _chain([(240, 525), (330, 515), (420, 510)], 44, 42)                  # body
    blobs += _chain([(420, 505), (470, 470), (510, 440)], 34, 24)                  # neck, raised
    blobs += _chain([(510, 435), (560, 430), (600, 438)], 24, 7)                   # head to pointed snout
    blobs += [((515, 410), 11)]                                                    # ear
    for x0, x1 in ((270, 262), (320, 316), (395, 412), (440, 462)):                # legs
        blobs += _chain([(x0, 540), (x1, 610)], 11, 8)
    _glow_shape(bd, blobs, mong, mong_fill)
    for sx in range(255, 440, 26):                                                 # fur stripes
        pygame.draw.line(bd, (255, 170, 60, 45), (sx, 482), (sx + 12, 508), 2)
    pygame.draw.circle(bd, (255, 230, 150, 170), (545, 425), 5)                    # eye
    pygame.draw.circle(bd, (255, 170, 60, 160), (600, 438), 4)                     # nose

    # --- viper, right, facing left: coils on the ground, neck rising, hood spread ---
    for i, (rx, ry, r) in reversed(list(enumerate(((165, 52, 22), (125, 40, 19), (85, 28, 16))))):
        cy = 590 - i * 24                     # bottom coil is the biggest and drawn last (in front)
        band = pygame.Rect(0, 0, (rx + r) * 2, (ry + r) * 2)
        band.center = (1010, cy)
        hole = pygame.Rect(0, 0, (rx - r) * 2, (ry - r) * 2)
        hole.center = (1010, cy)
        pygame.draw.ellipse(bd, vip_fill, band, r * 2)
        pygame.draw.ellipse(bd, vip, band, 3)
        pygame.draw.ellipse(bd, vip, hole, 3)
    coils = []
    coils += _chain([(1010, 540), (990, 470), (950, 420), (890, 395), (835, 392)], 18, 14)   # rising neck
    coils += _chain([(835, 385), (815, 365), (800, 360)], 26, 18)                            # hood
    coils += _chain([(835, 400), (815, 420), (800, 422)], 26, 18)
    coils += _chain([(805, 392), (770, 390), (745, 394)], 20, 12)                            # head
    _glow_shape(bd, coils, vip, vip_fill)
    pygame.draw.circle(bd, (255, 80, 80, 190), (775, 384), 5)                      # eye
    pygame.draw.lines(bd, (255, 80, 110, 140), False, [(735, 395), (708, 398), (695, 390)], 2)  # forked tongue
    pygame.draw.line(bd, (255, 80, 110, 140), (708, 398), (695, 407), 2)
    for k in range(7):                                                             # scale diamonds on the coil
        x = 870 + k * 46
        pygame.draw.polygon(bd, (80, 255, 140, 45), [(x, 630), (x + 9, 621), (x + 18, 630), (x + 9, 639)])
    return bd


def level_stats(level):
    level = max(1, level)
    return {
        "max_hp": 300 + (level - 1) * 35,
        "max_defense": 100 + (level - 1) * 20,
        "attack_power": 35 + (level - 1) * 4,
        "shot_cd": max(6, 14 - level // 5),             # frames between normal shots
        "special_cd": max(70, 180 - level * 3),         # frames between nova / venom burst
    }

def fighter_speed(level):
    return 6.8 + min(3.0, (max(1, level) - 1) * 0.06)

MAX_VIPERS_ON_SCREEN = 10

# Viper head strike (user, 2026-10-10): snakes close in and bite with a big extended head
STRIKE_RANGE = 200        # a mongoose this close gets struck instead of spat at
STRIKE_REACH = 165.0      # how far the head shoots out
STRIKE_STAND = 10         # frames the viper stands up (rears back) before it strikes - the warning
STRIKE_SHOOT = 3          # frames for the head to shoot out: very fast
STRIKE_HOLD = 3           # frames at full reach
STRIKE_FRAMES = 24        # stand 10, shoot 3, hold 3, pull back 8 (0.4 s)
STRIKE_HIT_RADIUS = 34    # bite hit size around the striking head (the mongoose is drawn bigger now)
STRIKE_HEAD_SCALE = 1.7   # head size at full reach

# Natural fighting (user, 2026-10-10): no lasers or Nova rings. The mongoose leaps and bites,
# its special is a Fury of bites all around; vipers strike, spit venom drops or spray venom.
BITE_LUNGE = 120.0        # how far the mongoose leaps on a bite
BITE_FRAMES = 8           # leap time
BITE_REACH = 40.0         # jaws are this far ahead of the mongoose's centre
BITE_RADIUS = 40          # bite hits a viper head this close (full damage), body/tail at 3/4 of it (half)
FURY_RADIUS = 130         # Fury: every viper this close gets bitten
FURY_FRAMES = 30          # dust cloud time
HOLE_COUNT = 16           # snake holes in the ground; vipers come out of them
HOLES = make_holes()

# Look of the fighters (drawing only, never changes hit sizes or balance)
MONGOOSE_SCALE = 1.6            # the fighting mongoose: big (user, 2026-10-10)
JUNGLE_MONGOOSE_SCALE = 0.8     # the other mongooses wandering in the jungle, smaller
JUNGLE_MONGOOSES = 6
JUNGLE_SNAKES = 4               # wild vipers roaming the jungle on their own
JUNGLE_SNAKE_SCALE = 0.8
JUNGLE_SPOT_RANGE = 220         # a wild mongoose and a wild snake this close spot each other and fight to the kill
JUNGLE_RESPAWN_FRAMES = 300     # a new wild animal turns up every 5 s while the jungle is short of one
VIPER_SCALE = 1.3               # fighting vipers: thick body, big head...
VIPER_SEGMENTS = 36             # ...and a very long tail (was 24 segments)
MONGOOSE_COLORS = {                 # fur, dark fur, belly, tail tip
    1: ((140, 124, 98), (80, 68, 52), (198, 182, 150), (45, 38, 30)),     # Indian grey mongoose
    2: ((172, 100, 54), (106, 56, 28), (224, 162, 112), (60, 30, 15)),    # ruddy mongoose
}
MONGOOSE_GRIZZLE = [(-24, -8), (-14, -4), (-4, -9), (6, -5), (16, -9), (-18, 2), (-6, 1), (8, 2), (20, -1)]
VIPER_PALETTES = {
    "ai": {"style": "chain", "body": (178, 142, 90), "head": (165, 128, 80), "outline": (38, 26, 16),
           "blotch": (96, 54, 28), "ring": (22, 14, 8), "rim": (236, 222, 186), "tail": None},       # Russell's viper
    "human": {"style": "bands", "body": (70, 165, 55), "head": (82, 182, 62), "outline": (18, 50, 16),
              "blotch": (40, 110, 35), "ring": (18, 50, 16), "rim": (200, 235, 120), "tail": (210, 70, 30)},  # green pit viper
}

# Human vs AI: every human-controlled character gets +10% attack, speed, defense and health
# on top of the normal level growth (which is the same rate for AI and humans).
# Player vs player (mode 3) stays exactly equal.
HUMAN_EDGE = 1.10

MODE_NAMES = {
    1: "SOLO MONGOOSE vs AI",
    2: "DUAL MONGOOSES vs AI",
    3: "MONGOOSE vs VIPER (P1 vs P2)",
    4: "VIPER vs AI MONGOOSE",
    5: "DUAL VIPERS vs AI MONGOOSES",
}
SQUIRREL_HUMAN_MODES = (1, 2, 3)     # modes where squirrels are human-controlled
VS_AI_MODES = (1, 2, 4, 5)           # humans on one side, AI on the other -> human +10%

def pack_size(level, squirrels=1):
    """Vipers per mongoose: 1 at levels 1-5, 2 at 6-10, 3 at 11-15 ... (the original growth),
    capped so there are never more than 10 vipers on screen in total."""
    grow = 1 + (max(1, level) - 1) // 5
    return max(1, min(grow, MAX_VIPERS_ON_SCREEN // max(1, squirrels)))

class Fighter:
    """Everything combat-related lives here, so mongoose and viper can never drift apart."""

    def apply_level_up(self, level, power_mult=1, human_edge=False):
        """power_mult: a mongoose facing a pack of N vipers gets N x HP, DEF and ATK,
        so both sides always have the same total strength.
        human_edge: a human playing against AI gets +10% HP, DEF, ATK (and speed)."""
        self.level = max(1, level)
        self.power_mult = max(1, power_mult)
        self.human_edge = bool(human_edge)
        edge = HUMAN_EDGE if self.human_edge else 1.0
        s = level_stats(self.level)
        self.max_hp = int(s["max_hp"] * self.power_mult * edge + 0.5)
        self.max_defense = int(s["max_defense"] * self.power_mult * edge + 0.5)
        self.attack_power = int(s["attack_power"] * self.power_mult * edge + 0.5)
        self.shot_cd = s["shot_cd"]
        self.special_cd = s["special_cd"]
        self.shot_timer = 0
        self.special_timer = 0
        self.contact_timer = 0
        self.boost_timer = 0
        self.refill()

    def power(self):
        """Attack damage right now: +25% while a shard power-up is active (same rule for both sides)."""
        return int(self.attack_power * SHARD_BOOST) if self.boost_timer > 0 else self.attack_power

    def collect_shard(self):
        self.boost_timer = SHARD_BOOST_FRAMES
        self.defense = min(self.max_defense, self.defense + 30)
        self.hp = min(self.max_hp, self.hp + 20)

    def refill(self):
        self.hp = self.max_hp
        self.defense = self.max_defense

    def grant_human_edge(self):
        """A character that a human takes over mid-fight (vs AI) gets the +10% on the spot."""
        if getattr(self, "human_edge", False):
            return
        self.human_edge = True
        for attr in ("max_hp", "hp", "max_defense", "defense", "attack_power"):
            setattr(self, attr, int(getattr(self, attr) * HUMAN_EDGE + 0.5))
        self.apply_speed()

    def apply_speed(self):
        pass

    def take_damage(self, amount):
        if self.defense > 0:
            absorbed = min(self.defense, amount)
            self.defense -= absorbed
            amount -= absorbed
        self.hp = max(0, self.hp - amount)

    def tick_timers(self):
        if self.shot_timer > 0:
            self.shot_timer -= 1
        if self.special_timer > 0:
            self.special_timer -= 1
        if self.contact_timer > 0:
            self.contact_timer -= 1
        if self.boost_timer > 0:
            self.boost_timer -= 1

    def try_shot(self):
        if self.hp <= 0 or self.shot_timer > 0:
            return False
        self.shot_timer = self.shot_cd
        return True

    def try_special(self):
        if self.hp <= 0 or self.special_timer > 0:
            return False
        self.special_timer = self.special_cd
        return True

# ---------------------------------------------------------
# 6. SQUIRREL
# ---------------------------------------------------------
class SquirrelPlayer(Fighter):
    def __init__(self, x, y, player_id=1, level=1):
        self.player_id = player_id
        self.x = float(x)
        self.y = float(y)
        self.score = 0
        self.kills = 0
        self.facing_right = True
        self.aim_angle = 0.0
        self.anim_t = 0.0
        self.is_ai = False          # True in the Viper modes, where the squirrels are AI-controlled
        self.lunge_t = 0            # frames left in a bite leap
        self.lunge_v = (0.0, 0.0)
        self.bite_ang = 0.0
        self.bite_done = True       # one bite per leap
        self.fury_t = 0             # frames left of the Fury dust cloud
        self.ai_t = random.uniform(0, 6)
        self.ai_fire_wait = random.randint(20, 50)
        self.apply_level_up(level)

    def apply_level_up(self, level, power_mult=1, human_edge=False):
        super().apply_level_up(level, power_mult, human_edge)
        self.apply_speed()

    def apply_speed(self):
        self.speed = fighter_speed(self.level) * (HUMAN_EDGE if self.human_edge else 1.0)

    def move(self, dx, dy):
        if dx > 0:
            self.facing_right = True
        elif dx < 0:
            self.facing_right = False
        if dx or dy:
            # Last direction moved: used to aim controller shots when the right stick is idle
            self.aim_angle = math.atan2(dy, dx)
        self.x = max(50, min(WIDTH - 50, self.x + dx * self.speed))
        self.y = max(50, min(HEIGHT - 50, self.y + dy * self.speed))

    def update(self):
        self.anim_t += 0.15
        self.tick_timers()
        if self.lunge_t > 0:
            self.lunge_t -= 1
            self.x = max(50, min(WIDTH - 50, self.x + self.lunge_v[0]))
            self.y = max(50, min(HEIGHT - 50, self.y + self.lunge_v[1]))
        if self.fury_t > 0:
            self.fury_t -= 1
            self.anim_t += 0.3

    def start_bite(self, tx, ty):
        """Leap BITE_LUNGE px toward the target with the jaws open."""
        self.bite_ang = math.atan2(ty - self.y, tx - self.x)
        c, s = math.cos(self.bite_ang), math.sin(self.bite_ang)
        if abs(c) > 0.15:
            self.facing_right = c > 0
        self.lunge_v = (c * BITE_LUNGE / BITE_FRAMES, s * BITE_LUNGE / BITE_FRAMES)
        self.lunge_t = BITE_FRAMES
        self.bite_done = False

    def bite_point(self):
        return self.x + math.cos(self.bite_ang) * BITE_REACH, self.y + math.sin(self.bite_ang) * BITE_REACH

    def draw(self, surface):
        """A real-looking, fighting-mad mongoose (user, 2026-10-10): grizzled fur, long low body,
        bristling crest and puffed-up tail, red eyes, bared fangs, claws. Drawn in side view,
        bigger than the old mongoose; the hit size (HIT_RADIUS) is unchanged so balance stays the same."""
        S = getattr(self, "scale", MONGOOSE_SCALE)
        f = 1 if self.facing_right else -1
        ox, oy = self.x, self.y
        fur, dark, light, tip = MONGOOSE_COLORS.get(self.player_id, MONGOOSE_COLORS[1])
        outline = (22, 18, 14)

        def at(lx, ly):
            return (int(ox + lx * S * f), int(oy + ly * S))

        def circ(col, lx, ly, r):
            pygame.draw.circle(surface, col, at(lx, ly), max(1, int(r * S)))

        def oval(col, cx, cy, w, h):
            rect = pygame.Rect(0, 0, int(w * S), int(h * S))
            rect.center = at(cx, cy)
            pygame.draw.ellipse(surface, col, rect)

        def poly(col, pts, width=0):
            pygame.draw.polygon(surface, col, [at(*p) for p in pts], width)

        def line(col, a, b, w):
            pygame.draw.line(surface, col, at(*a), at(*b), max(1, int(w * S)))

        last = getattr(self, "_last_xy", (ox, oy))
        moving = math.hypot(ox - last[0], oy - last[1]) > 0.3
        self._last_xy = (ox, oy)
        stride = math.sin(self.anim_t * 2.4) if moving else 0.0
        wave = math.sin(self.anim_t * 1.3)
        jaw = 7 if self.lunge_t > 0 or self.fury_t > 0 else 2     # jaws wide open while biting
        if self.fury_t > 0:                                         # Fury: dust kicked up all around
            for k in range(10):
                a = self.anim_t * 2.0 + k * math.tau / 10
                rr = FURY_RADIUS * (0.45 + 0.5 * ((k * 37) % 10) / 10)
                pygame.draw.circle(surface, (120, 98, 68), (int(ox + math.cos(a) * rr), int(oy + math.sin(a) * rr * 0.6)), 9 - k % 4)
                pygame.draw.circle(surface, (150, 126, 90), (int(ox + math.cos(a) * rr), int(oy + math.sin(a) * rr * 0.6)), 5 - k % 3)

        oval((34, 26, 17), -6, 27, 150, 12)                        # shadow on the ground
        oval((34, 26, 17), -70, 14, 50, 8)

        # Tail: long and tapering, fur puffed up the way a mongoose fluffs it against a snake
        tail = _chain([(-34, -2), (-52, wave * 2), (-68, 4 + wave * 4), (-84, 2 + wave * 6), (-98, -2 + wave * 7)], 14, 5, step=4)
        for (lx, ly), r in tail:
            circ(outline, lx, ly, r + 1.5)
        for k, ((lx, ly), r) in enumerate(tail):
            circ(tip if k > len(tail) * 0.72 else fur, lx, ly, r)
        for k in range(0, len(tail) - 2, 2):
            (lx, ly), r = tail[k]
            line(dark, (lx, ly - r + 1), (lx - 4, ly - r - 5), 1.5)
            line(dark, (lx, ly + r - 1), (lx - 4, ly + r + 4), 1.5)

        def leg(hx, phase, col):
            sw = stride * 7 * phase
            knee, foot = (hx + sw * 0.4, 15), (hx + sw, 24)
            line(outline, (hx, 6), knee, 11)
            line(outline, knee, foot, 9)
            line(col, (hx, 6), knee, 8)
            line(col, knee, foot, 6)
            oval(outline, foot[0] + 2, foot[1], 11, 6)
            for c in (-1.5, 0, 1.5):                                         # claws
                line((235, 230, 215), (foot[0] + 6, foot[1] + c), (foot[0] + 9, foot[1] + c + 1), 1)

        leg(-26, -1, dark)          # far legs
        leg(18, 1, dark)

        # Body: long and low, lighter belly, grizzled fur, bristling crest along the back
        oval(outline, 0, 0, 84, 34)
        oval(fur, 0, 0, 80, 30)
        oval(light, 2, 7, 62, 13)
        for lx in range(-34, 24, 6):
            spike = [(lx, -12), (lx + 2, -20 - ((lx // 6) % 2) * 3), (lx + 6, -12)]
            poly(dark, spike)
            poly(outline, spike, 1)
        for lx, ly in MONGOOSE_GRIZZLE:
            line(dark, (lx, ly), (lx - 3, ly + 5), 1.5)
            line(light, (lx + 3, ly + 1), (lx + 1, ly + 4), 1)

        leg(-20, 1, fur)            # near legs
        leg(24, -1, fur)

        # Neck and head, raised and pushed forward to strike
        oval(outline, 28, -9, 26, 24)
        oval(fur, 28, -9, 22, 20)
        oval(outline, 40, -14, 34, 26)
        oval(fur, 40, -14, 30, 22)
        poly((110, 18, 24), [(48, -8), (67, -10), (62, -9 + jaw), (48, -6 + jaw * 0.6)])   # open mouth
        for tx in (52, 56):                                                               # teeth
            poly((245, 240, 225), [(tx, -9), (tx + 2, -9), (tx + 1, -6.5)])
        poly((250, 248, 235), [(60, -10), (62.5, -10), (61, -4.5)])                       # upper fang
        poly((250, 248, 235), [(57, -7 + jaw * 0.8), (59, -7 + jaw * 0.8), (58, -11 + jaw * 0.8)])  # lower fang
        line(fur, (48, -5 + jaw * 0.6), (62, -8 + jaw), 3)                                # lower jaw
        snout = [(50, -22), (66, -15), (68, -11), (52, -8)]
        poly(fur, snout)
        poly(outline, snout, 2)
        circ((30, 22, 22), 67, -13, 3)                                                    # nose
        circ(outline, 31, -24, 5.5)                                                       # ear
        circ(dark, 31, -24, 4.5)
        circ(light, 31, -23, 2)
        circ(outline, 45, -17, 4.2)                                                       # red eye
        circ((235, 70, 25), 45, -17, 3.2)
        circ((10, 5, 5), 46, -17, 1.6)
        circ((255, 230, 200), 44, -18, 0.8)
        line(outline, (38, -23), (50, -19), 2.5)                                          # angry brow
        for dy in (-3, 0, 3):                                                             # whiskers
            line(light, (60, -13), (73, -14 + dy), 0.8)

class JungleMongoose:
    """One of the many mongooses living in the jungle (user, 2026-10-10). Smaller than the
    fighting mongoose, wanders between the grass and the holes, never fights, can't be hit."""

    def __init__(self, rnd, from_edge=False):
        if from_edge:                           # a newcomer walks in from the side of the jungle
            x, y = rnd.choice((-30.0, WIDTH + 30.0)), rnd.uniform(160, HEIGHT - 110)
        else:
            x, y = rnd.uniform(80, WIDTH - 80), rnd.uniform(150, HEIGHT - 110)
        self.body = SquirrelPlayer(x, y, player_id=rnd.choice((1, 2)))
        self.body.scale = JUNGLE_MONGOOSE_SCALE
        self.body.anim_t = rnd.uniform(0, 6)
        self.rnd = rnd
        self.speed = rnd.uniform(0.9, 1.7)
        self.rest = 0
        self.hp = 100.0
        self.foe = None                         # the wild snake it is fighting
        self.bite_wait = rnd.randint(15, 40)
        self.pick()

    def fight(self, particles):
        """Close in on the snake's head, leap and bite; one bite per leap."""
        b, s = self.body, self.foe.v
        b.update()                              # bite leap movement + timers
        dx, dy = s.x - b.x, s.y - b.y
        d = math.hypot(dx, dy) or 1.0
        if b.lunge_t <= 0:
            if d > 105:
                b.x += dx / d * 2.6
                b.y += dy / d * 2.6
            elif d < 70:
                b.x -= dx / d * 2.0
                b.y -= dy / d * 2.0
            else:                               # circles the snake, looking for an opening
                b.x += -dy / d * 1.4
                b.y += dx / d * 1.4
            if abs(dx) > 1:
                b.facing_right = dx > 0
        self.bite_wait -= 1
        if self.bite_wait <= 0 and b.lunge_t <= 0 and d < BITE_LUNGE + BITE_REACH:
            b.start_bite(s.x, s.y)
            self.bite_wait = self.rnd.randint(40, 75)
        if b.lunge_t > 0 and not b.bite_done:
            bx, by = b.bite_point()
            dmg = 0
            if math.hypot(bx - s.x, by - s.y) < BITE_RADIUS:
                dmg = self.rnd.randint(24, 36)
            elif any(math.hypot(bx - sx, by - sy) < BITE_RADIUS * 0.75 for sx, sy, _r, _i in s.segment_points()):
                dmg = self.rnd.randint(12, 18)
            if dmg:
                self.foe.hp -= dmg
                b.bite_done = True
                for _ in range(6):
                    particles.append(Particle(bx, by, (200, 40, 50)))

    def pick(self):
        self.tx, self.ty = self.rnd.uniform(70, WIDTH - 70), self.rnd.uniform(150, HEIGHT - 100)

    def step(self, particles=None):
        b = self.body
        if self.foe is not None:
            self.fight(particles if particles is not None else [])
            return
        self.hp = min(100.0, self.hp + 0.05)   # heals slowly after a fight
        if self.rest > 0:                      # stops now and then to sniff around
            self.rest -= 1
            return
        dx, dy = self.tx - b.x, self.ty - b.y
        d = math.hypot(dx, dy)
        if d < 6:
            self.pick()
            self.rest = self.rnd.randint(30, 150)
            return
        b.x += dx / d * self.speed
        b.y += dy / d * self.speed
        if abs(dx) > 1:
            b.facing_right = dx > 0
        b.anim_t += 0.15

    def draw(self, surface):
        self.body.draw(surface)


class JungleSnake:
    """A wild viper (user, 2026-10-10): crawls out of a hole, roams the jungle on its own, and fights
    any wild mongoose it spots. Smaller than the fighting vipers; never touches the players' fight."""

    def __init__(self, rnd, hole):
        self.v = ViperEnemy(level=1, spawn=hole, hole=hole)
        self.v.scale = JUNGLE_SNAKE_SCALE
        self.v.num_segments = 24
        self.rnd = rnd
        self.hp = 100.0
        self.foe = None                         # the wild mongoose it is fighting
        self.strike_wait = rnd.randint(20, 50)
        self.pick()

    def pick(self):
        self.tx, self.ty = self.rnd.uniform(70, WIDTH - 70), self.rnd.uniform(150, HEIGHT - 100)

    def crawl(self, tx, ty, speed):
        v = self.v
        ang = math.atan2(ty - v.y, tx - v.x)
        wig = math.sin(v.slither_t) * 0.6
        v.x += math.cos(ang + wig) * speed
        v.y += math.sin(ang + wig) * speed
        if v.strike_t <= 0:
            v.heading = ang
        v._push_history()

    def step(self, particles):
        v = self.v
        v.slither_t += 0.14
        v.tick_strike()
        if self.foe is None:
            self.hp = min(100.0, self.hp + 0.05)
            if math.hypot(self.tx - v.x, self.ty - v.y) < 12:
                self.pick()
            self.crawl(self.tx, self.ty, 1.5)
            return
        m = self.foe.body
        d = math.hypot(m.x - v.x, m.y - v.y)
        if v.strike_t > 0:
            self.crawl(m.x, m.y, 0.3)
        elif d > 140:
            self.crawl(m.x, m.y, 2.2)
        else:
            self.crawl(m.x, m.y, 0.6)
        self.strike_wait -= 1
        if self.strike_wait <= 0 and v.strike_t <= 0 and d < STRIKE_RANGE:
            v.start_strike(m.x, m.y)
            self.strike_wait = self.rnd.randint(45, 80)
        if v.strike_can_hit():
            hx, hy = v.strike_tip()
            sx, sy = hx - v.x, hy - v.y
            k = max(0.0, min(1.0, ((m.x - v.x) * sx + (m.y - v.y) * sy) / (sx * sx + sy * sy or 1.0)))
            if math.hypot(v.x + sx * k - m.x, v.y + sy * k - m.y) < STRIKE_HIT_RADIUS * 0.8:
                self.foe.hp -= self.rnd.randint(18, 30)
                v.strike_hit = True
                for _ in range(6):
                    particles.append(Particle(hx, hy, (200, 40, 50)))

    def draw(self, surface):
        self.v.draw(surface)


def jungle_life(mongooses, snakes, fx, particles, rnd, clock, busy_holes):
    """One frame of the wild jungle: everyone roams on their own; a free wild mongoose and a free
    wild snake that spot each other fight until one is dead; newcomers keep the jungle full."""
    for m in mongooses:
        if m.foe is not None:
            continue
        free = [s for s in snakes if s.foe is None and not s.v.hole]
        if free:
            s = min(free, key=lambda s: math.hypot(s.v.x - m.body.x, s.v.y - m.body.y))
            if math.hypot(s.v.x - m.body.x, s.v.y - m.body.y) < JUNGLE_SPOT_RANGE:
                m.foe, s.foe = s, m
    for m in mongooses:
        m.step(particles)
    for s in snakes:
        s.step(particles)
    for s in snakes[:]:
        if s.hp <= 0:                           # the snake is killed: it breaks apart
            fx.extend(s.v.burst_pieces())
            if s.foe is not None:
                s.foe.foe = None
            snakes.remove(s)
    for m in mongooses[:]:
        if m.hp <= 0:                           # the mongoose is killed: it collapses in the dust
            for _ in range(14):
                particles.append(Particle(m.body.x, m.body.y, (140, 115, 80)))
            if m.foe is not None:
                m.foe.foe = None
            mongooses.remove(m)
    clock["t"] += 1
    if clock["t"] >= JUNGLE_RESPAWN_FRAMES:
        clock["t"] = 0
        if len(snakes) < JUNGLE_SNAKES:
            holes = [h for h in HOLES if h not in busy_holes]
            if holes:
                snakes.append(JungleSnake(rnd, rnd.choice(holes)))
        if len(mongooses) < JUNGLE_MONGOOSES:
            mongooses.append(JungleMongoose(rnd, from_edge=True))
    for piece in fx[:]:
        piece.update()
        if piece.life <= 0:
            fx.remove(piece)


def draw_peeking_snake(surface, hole, t, k):
    """A viper waiting in its hole: the head pokes out and the tongue flicks."""
    hx, hy = hole
    pal = VIPER_PALETTES["ai"]
    ang = -math.pi / 2 + math.sin(t * 0.03 + k) * 0.9           # head turns slowly, looking around
    out = 6 + 4 * math.sin(t * 0.05 + k * 1.7)                  # bobs in and out of the hole
    cu, su = math.cos(ang), math.sin(ang)
    cx, cy = hx + cu * out, hy + su * out * 0.5

    def H(u, v):
        return (cx + cu * u - su * v, cy + su * u + cu * v)

    pygame.draw.circle(surface, pal["outline"], (int(hx), int(hy)), 10)
    pygame.draw.circle(surface, pal["body"], (int(hx), int(hy)), 8)
    if math.sin(t * 0.11 + k * 2.3) > 0.6:
        red = (215, 30, 60)
        pygame.draw.line(surface, red, H(17, 0), H(25, 0), 2)
        pygame.draw.lines(surface, red, False, [H(29, -3), H(25, 0), H(29, 3)], 2)
    head = [(16, -3), (18, 0), (16, 3), (9, 7), (1, 9), (-5, 6), (-6, 0), (-5, -6), (1, -9), (9, -7)]
    pygame.draw.polygon(surface, pal["head"], [H(u, v) for u, v in head])
    pygame.draw.polygon(surface, pal["outline"], [H(u, v) for u, v in head], 2)
    pygame.draw.polygon(surface, pal["blotch"], [H(u, v) for u, v in ((10, 0), (1, -6), (-3, -5), (5, 0), (-3, 5), (1, 6))])
    for side in (-1, 1):
        pygame.draw.circle(surface, (235, 190, 40), H(5, 6 * side), 3)
        pygame.draw.line(surface, (10, 10, 10), H(4, 6 * side), H(7, 6 * side), 1)


# ---------------------------------------------------------
# 7. VIPER
# ---------------------------------------------------------
class ViperEnemy(Fighter):
    def __init__(self, level=1, is_player_controlled=False, spawn=None, controller=None, human_edge=False, hole=None):
        # controller: 1 = steered by player 1's keys/pad/touch, 2 = by player 2's; None = AI
        self.controller = controller if controller else (2 if is_player_controlled else None)
        self.is_player_controlled = bool(self.controller)
        self.tail_scale = 1.0   # tail never shrinks, so the viper never gets harder to hit

        if spawn is not None:
            self.x, self.y = float(spawn[0]), float(spawn[1])
        else:
            side = random.choice(["L", "R", "T", "B"])
            if side == "L":
                self.x, self.y = -60.0, random.uniform(80, HEIGHT - 80)
            elif side == "R":
                self.x, self.y = float(WIDTH + 60), random.uniform(80, HEIGHT - 80)
            elif side == "T":
                self.x, self.y = random.uniform(80, WIDTH - 80), -60.0
            else:
                self.x, self.y = random.uniform(80, WIDTH - 80), float(HEIGHT + 60)

        self.num_segments = VIPER_SEGMENTS
        self.history = [(self.x, self.y) for _ in range(self.num_segments * 3 + 12)]
        self.heading = math.pi if self.x > WIDTH / 2 else 0.0
        self.slither_t = random.uniform(0, 10)
        self.ai_fire_wait = random.randint(40, 90)
        self.last_hit_by = None
        self.strike_t = 0          # frames left in a head strike (0 = not striking)
        self.strike_ang = 0.0
        self.strike_hit = False    # a strike can hit only once
        self.hole = hole           # the hole it is crawling out of (body inside the hole is hidden)
        self.apply_level_up(level, human_edge=human_edge)

    def apply_level_up(self, level, power_mult=1, human_edge=False):
        super().apply_level_up(level, power_mult, human_edge)
        self.apply_speed()

    def apply_speed(self):
        if self.is_player_controlled:
            # human viper moves exactly like the squirrel (+10% when playing against AI)
            self.base_speed = fighter_speed(self.level) * (HUMAN_EDGE if self.human_edge else 1.0)
        else:
            self.base_speed = 3.0 + min(3.5, (self.level - 1) * 0.05)

    def _push_history(self):
        self.history.insert(0, (self.x, self.y))
        max_h = self.num_segments * 3 + 12
        if len(self.history) > max_h:
            self.history = self.history[:max_h]
        if self.hole and math.hypot(self.history[-1][0] - self.hole[0], self.history[-1][1] - self.hole[1]) > 30:
            self.hole = None       # the whole snake is out of its hole

    def start_strike(self, tx, ty):
        """Head strike at a nearby mongoose (user, 2026-10-10): rear back, shoot the head out
        STRIKE_REACH px with jaws open, pull back. Same damage and cooldown as a venom spit."""
        self.strike_t = STRIKE_FRAMES
        self.strike_ang = math.atan2(ty - self.y, tx - self.x)
        self.heading = self.strike_ang
        self.strike_hit = False

    def strike_extension(self):
        """How far the head is pushed out right now (negative = rearing back)."""
        if self.strike_t <= 0:
            return 0.0
        done = STRIKE_FRAMES - self.strike_t
        if done < STRIKE_STAND:                                            # stands up, head drawn back
            return -15.0 * (done + 1) / STRIKE_STAND
        done -= STRIKE_STAND
        if done < STRIKE_SHOOT:                                            # head shoots out, fast
            return -15.0 + (STRIKE_REACH + 15.0) * (done + 1) / STRIKE_SHOOT
        done -= STRIKE_SHOOT
        if done < STRIKE_HOLD:
            return STRIKE_REACH
        done -= STRIKE_HOLD
        back = STRIKE_FRAMES - STRIKE_STAND - STRIKE_SHOOT - STRIKE_HOLD   # pull back
        return STRIKE_REACH * (1.0 - (done + 1) / back)

    def standing(self):
        """0..1: how far the viper has reared up (stand phase), stays up until the strike ends."""
        if self.strike_t <= 0:
            return 0.0
        return min(1.0, (STRIKE_FRAMES - self.strike_t + 1) / STRIKE_STAND)

    def strike_tip(self):
        ext = self.strike_extension()
        return self.x + math.cos(self.strike_ang) * ext, self.y + math.sin(self.strike_ang) * ext

    def strike_can_hit(self):
        return self.strike_t > 0 and not self.strike_hit and self.strike_extension() > STRIKE_REACH * 0.35

    def tick_strike(self):
        if self.strike_t > 0:
            self.strike_t -= 1

    def update_ai(self, targets, projectiles_list, spit_fn, burst_fn, shards=()):
        self.slither_t += 0.14
        self.tick_timers()
        self.tick_strike()
        active_targets = [t for t in targets if t.hp > 0]
        if not active_targets:
            return

        closest_target = min(active_targets, key=lambda t: math.hypot(t.x - self.x, t.y - self.y))
        tx, ty = closest_target.x, closest_target.y
        dist = math.hypot(tx - self.x, ty - self.y)

        # Race the squirrel for power-up shards, just like a player would
        move_x, move_y = tx, ty
        if shards and self.boost_timer <= 0:
            near = min(shards, key=lambda s: math.hypot(s.x - self.x, s.y - self.y))
            d_s = math.hypot(near.x - self.x, near.y - self.y)
            if d_s < 320 and d_s < dist:
                move_x, move_y = near.x, near.y

        # Evade player lasers
        evade_x, evade_y = 0.0, 0.0
        for p in projectiles_list:
            if not p.is_hostile:
                d_p = math.hypot(p.x - self.x, p.y - self.y)
                if d_p < 140:
                    evade_x += -p.vy / (d_p + 1) * 35.0
                    evade_y += p.vx / (d_p + 1) * 35.0
                    break

        lunge = 1.35 if dist < 170 else 1.0
        if self.strike_t > 0:
            lunge = 0.4                    # body slows while the head strikes
        angle = math.atan2(move_y - self.y, move_x - self.x)
        wiggle = math.sin(self.slither_t) * 0.70
        self.heading = self.strike_ang if self.strike_t > 0 else angle

        self.x += (math.cos(angle + wiggle) * self.base_speed * lunge) + evade_x
        self.y += (math.sin(angle + wiggle) * self.base_speed * lunge) + evade_y
        self._push_history()

        # Same weapons and cooldowns as the mongoose; the AI just chooses to fire less often.
        # AI vipers spit venom from far away; a mongoose within STRIKE_RANGE gets a stand-up head strike instead (user, 2026-10-10).
        self.ai_fire_wait -= 1
        if dist < 220 and self.special_timer <= 0:
            burst_fn(self)
        elif self.ai_fire_wait <= 0 and self.strike_t <= 0 and dist < 450:
            self.ai_fire_wait = self.shot_cd * 4 + random.randint(0, 30)
            spit_fn(self, tx, ty)

    def update_manual(self, dx, dy):
        self.slither_t += 0.14
        self.tick_timers()
        self.tick_strike()
        if (dx or dy) and self.strike_t <= 0:
            self.heading = math.atan2(dy, dx)
        self.x = max(50, min(WIDTH - 50, self.x + dx * self.base_speed))
        self.y = max(50, min(HEIGHT - 50, self.y + dy * self.base_speed))
        self._push_history()

    def segment_points(self):
        """(x, y, radius, index) of every body/tail segment, exactly where draw() puts them."""
        pts = []
        for i in range(1, self.num_segments):
            idx = min(len(self.history) - 1, i * 3)
            sx, sy = self.history[idx]
            ratio = 1.0 - (i / self.num_segments)
            pts.append((sx, sy, int(max(3, (7 + ratio * 8) * self.tail_scale)), i))
        return pts

    def palette(self):
        return VIPER_PALETTES["human" if self.is_player_controlled else "ai"]

    def colors(self, i):
        """(outer, inner) colours of segment i -- same palette as draw()."""
        pal = self.palette()
        return (pal["blotch"] if i % 2 == 0 else pal["outline"]), pal["body"]

    def burst_pieces(self):
        """The viper broken into pieces: one per segment plus the head."""
        pieces = [BurstPiece(sx, sy, r, *self.colors(i), self.x, self.y) for sx, sy, r, i in self.segment_points()]
        pal = self.palette()
        for _ in range(3):   # the head splits into three bigger pieces
            pieces.append(BurstPiece(self.x, self.y, 11, pal["outline"], pal["head"], self.x, self.y))
        return pieces

    def body_radius(self, t):
        """Real snake shape: thin neck behind a wide head, thick body, tail tapering to a point."""
        r = 2.0 + 11.0 * (1.0 - t) ** 0.85
        if t < 0.06:
            r *= 0.8 + t / 0.06 * 0.2
        return r * getattr(self, "scale", VIPER_SCALE)

    def draw(self, surface):
        """A real-looking viper seen from above (user, 2026-10-10): smooth tapering body,
        scale pattern, triangular head, slit-pupil eyes, flicking forked tongue.
        AI vipers are Russell's vipers (tan with chained dark ovals); a human-steered viper is a
        green pit viper with a red tail tip, so players can always tell their own snake apart."""
        pal = self.palette()
        n = self.num_segments * 3

        # Smooth centre line, a point every ~3 px from the head back to the tail tip
        path, prev = [], None
        for k, (px, py) in enumerate(self.history[:n]):
            t = k / n
            if prev is None:
                path.append((px, py, t))
                prev = (px, py, t)
                continue
            d = math.hypot(px - prev[0], py - prev[1])
            if d < 3:
                continue
            steps = int(d / 3)
            for s in range(1, steps + 1):
                a = s / steps
                path.append((prev[0] + (px - prev[0]) * a, prev[1] + (py - prev[1]) * a, prev[2] + (t - prev[2]) * a))
            prev = (px, py, t)

        if self.hole:                                              # the part still inside the hole is hidden
            hx, hy = self.hole
            path = [q for q in path if math.hypot(q[0] - hx, q[1] - hy) > 13]
        for x, y, t in path[::2]:                                  # shadow on the ground
            pygame.draw.circle(surface, (34, 26, 17), (int(x + 3), int(y + 5)), int(self.body_radius(t) + 2))
        for x, y, t in path:
            pygame.draw.circle(surface, pal["outline"], (int(x), int(y)), int(self.body_radius(t) + 2))
        for x, y, t in reversed(path):
            col = pal["tail"] if pal["tail"] and t > 0.8 else pal["body"]
            pygame.draw.circle(surface, col, (int(x), int(y)), max(1, int(self.body_radius(t))))

        def frame(idx):
            ax, ay = path[max(0, idx - 2)][:2]
            bx, by = path[min(len(path) - 1, idx + 2)][:2]
            dx, dy = ax - bx, ay - by
            L = math.hypot(dx, dy) or 1.0
            return dx / L, dy / L

        def oval(cx, cy, ux, uy, a, b, col):
            pts = []
            for k in range(10):
                ang = k * math.pi / 5
                ca, sa = math.cos(ang) * a, math.sin(ang) * b
                pts.append((cx + ux * ca - uy * sa, cy + uy * ca + ux * sa))
            pygame.draw.polygon(surface, col, pts)

        # Scale pattern along the back
        for idx in range(5, len(path) - 3, 7) if len(path) > 8 else ():
            x, y, t = path[idx]
            r = self.body_radius(t)
            if r < 4 or (pal["tail"] and t > 0.8):
                continue
            ux, uy = frame(idx)
            if pal["style"] == "chain":
                oval(x, y, ux, uy, r * 0.62 + 2.2, r * 0.48 + 2.2, pal["rim"])
                oval(x, y, ux, uy, r * 0.62 + 1.0, r * 0.48 + 1.0, pal["ring"])
                oval(x, y, ux, uy, r * 0.62, r * 0.48, pal["blotch"])
                if idx + 3 < len(path) - 1:                       # side rows of smaller spots
                    sx, sy, st = path[idx + 3]
                    sr = self.body_radius(st)
                    vx, vy = frame(idx + 3)
                    for side in (-1, 1):
                        oval(sx - vy * sr * 0.72 * side, sy + vx * sr * 0.72 * side, vx, vy, sr * 0.26, sr * 0.2, pal["blotch"])
            else:
                oval(x, y, ux, uy, r * 0.22, r * 0.95, pal["blotch"])
                oval(x - uy * r * 0.35, y + ux * r * 0.35, ux, uy, r * 0.5, r * 0.12, pal["rim"])

        # Head strike: the neck stretches out and the head grows, jaws wide open
        ext = self.strike_extension()
        reach = max(0.0, ext) / STRIKE_REACH
        stand = self.standing()
        hs = getattr(self, "scale", VIPER_SCALE) * max(1.0 + 0.35 * stand, 1.0 + (STRIKE_HEAD_SCALE - 1.0) * reach)   # raised head looks bigger
        ang = self.strike_ang if self.strike_t > 0 else self.heading
        cu, su = math.cos(ang), math.sin(ang)
        hx0, hy0 = self.x + cu * ext, self.y + su * ext
        if ext > 2:
            neck = _chain([(self.x, self.y), (hx0, hy0)], self.body_radius(0.0), self.body_radius(0.0) * (1 + reach * 0.3), step=3)
            for (nx, ny), r in neck:
                pygame.draw.circle(surface, pal["outline"], (int(nx), int(ny)), int(r + 2))
            for (nx, ny), r in neck:
                pygame.draw.circle(surface, pal["body"], (int(nx), int(ny)), int(r))
            for k in range(2, len(neck) - 2, 5):
                (nx, ny), r = neck[k]
                oval(nx, ny, cu, su, r * 0.22, r * 0.9, pal["blotch"])

        if stand > 0:                                                         # shadow under the raised head
            sh = pygame.Rect(0, 0, int(34 * hs), int(18 * hs))
            sh.center = (int(hx0 + 6), int(hy0 + 10 * stand))
            pygame.draw.ellipse(surface, (8, 8, 14), sh)

        def H(u, v):
            u, v = u * hs, v * hs
            return (hx0 + cu * u - su * v, hy0 + su * u + cu * v)

        if reach > 0.3:                                                       # open mouth and fangs
            pygame.draw.polygon(surface, pal["outline"], [H(18, -9), H(36, -15), H(30, 0), H(36, 15), H(18, 9)])
            pygame.draw.polygon(surface, (200, 40, 70), [H(19, -7), H(34, -13), H(28, 0), H(34, 13), H(19, 7)])
            for side in (-1, 1):
                pygame.draw.polygon(surface, (250, 248, 235), [H(33, 12 * side), H(30, 9 * side), H(24, 9 * side)])
                pygame.draw.polygon(surface, (250, 248, 235), [H(31, 7 * side), H(29, 4 * side), H(25, 6 * side)])

        tongue_out = reach <= 0.3 and math.sin(self.slither_t * 1.7) > 0.55
        if tongue_out:
            red = (215, 30, 60)
            pygame.draw.line(surface, red, H(25, 0), H(36, 0), 2)
            pygame.draw.lines(surface, red, False, [H(41, -4), H(36, 0), H(41, 4)], 2)
        head = [(24, -4), (26, 0), (24, 4), (14, 10), (2, 13), (-7, 9), (-9, 0), (-7, -9), (2, -13), (14, -10)]
        pygame.draw.polygon(surface, pal["head"], [H(u, v) for u, v in head])
        pygame.draw.polygon(surface, pal["outline"], [H(u, v) for u, v in head], 2)
        pygame.draw.polygon(surface, pal["blotch"], [H(u, v) for u, v in ((15, 0), (1, -9), (-4, -7), (8, 0), (-4, 7), (1, 9))])
        for side in (-1, 1):
            pygame.draw.circle(surface, pal["outline"], H(8, 9 * side), int(5 * hs))
            pygame.draw.circle(surface, (235, 190, 40), H(8, 9 * side), int(4 * hs))
            pygame.draw.line(surface, (10, 10, 10), H(5.5, 9 * side), H(10.5, 9 * side), 2)    # slit pupil
            pygame.draw.line(surface, pal["outline"], H(2, 12.5 * side), H(14, 11 * side), 2)   # brow ridge
            pygame.draw.circle(surface, pal["outline"], H(21, 2.5 * side), 1)                    # nostril

# ---------------------------------------------------------
# 8. MAIN ENGINE LOOP
# ---------------------------------------------------------
async def main():
    global audio_muted
    try:
        pygame.mixer.pre_init(44100, -16, 2, 512)
    except Exception:
        pass
    pygame.init()
    try:
        pygame.mixer.init()
    except Exception:
        pass

    screen = pygame.display.set_mode((WIDTH, HEIGHT))
    fit_canvas_to_browser()
    fit_clock = 0
    pygame.display.set_caption(GAME_NAME)
    canvas = pygame.Surface((WIDTH, HEIGHT))
    ground = make_ground()
    jungle_rnd = random.Random()
    jungle = [JungleMongoose(jungle_rnd) for _ in range(JUNGLE_MONGOOSES)]
    wild_snakes = [JungleSnake(jungle_rnd, h) for h in jungle_rnd.sample(HOLES, JUNGLE_SNAKES)]
    wild_fx = []                       # pieces of wild snakes killed by wild mongooses
    wild_clock = {"t": 0}
    world_t = {"t": 0}
    backdrop = make_backdrop()
    clock = pygame.time.Clock()

    font_hud = pygame.font.SysFont("consolas", 14, bold=True)
    font_hud_sm = pygame.font.SysFont("consolas", 11, bold=True)
    font_big = pygame.font.SysFont("arial", 48, bold=True)

    tune_key = None

    game_mode = 1  # 1: Solo vs AI, 2: Dual Squirrel vs AI, 3: Squirrel vs Viper
    level_state = {"level": 1, "kills": 0}
    players = []
    vipers = []
    projectiles = []
    particles = []
    shards = []
    reserve = []                       # rest of the pack, waiting in the holes (controller per viper)
    high_score = get_stored_high_score()
    pvp_wins = {"mongoose": 0, "viper": 0}
    viper_team = {"score": 0}          # Viper modes (4, 5): points for beating AI squirrels
    wave_state = {"pending": True}     # a new viper pack is due (start of a level)
    bursts = []                        # pieces + flash of beaten vipers (BurstPiece / BurstFlash)
    after_burst = {"action": None}     # level-up / round-over waiting for the burst to finish
    banner = {"text": "", "timer": 0}
    shard_clock = {"t": 0}

    shake_intensity = 0
    show_help = True   # the game opens on the "how to play / all keys" screen (H shows it again)
    game_over = False

    # ---- Game controllers: pad 1 = Squirrel P1, pad 2 = Squirrel P2 (Dual) or the Viper (PvP) ----
    try:
        pygame.joystick.init()
    except Exception:
        pass
    pads = {}   # instance_id -> Joystick, kept in the order they were plugged in
    PAD_DEAD = 0.3
    PAD_START = 9 if sys.platform == "emscripten" else 7   # browser vs desktop button numbering
    PAD_SHOOT = (0, 2)          # A, X
    PAD_SPECIAL = (1, 3, 4, 5)  # B, Y, LB, RB

    def pad_role(j):
        """Which character this controller drives in the current mode (None = unused)."""
        order = list(pads.values())
        idx = order.index(j) if j in order else -1
        # roles: "p1"/"p2" = squirrel 1/2, "viper1" = player 1's viper, "viper" = player 2's viper
        if idx == 0:
            return "viper1" if game_mode in (4, 5) else "p1"
        if idx == 1:
            return {2: "p2", 3: "viper", 5: "viper"}.get(game_mode)
        return None

    def pad_for(role):
        for j in pads.values():
            if pad_role(j) == role:
                return j
        return None

    def pad_move(role):
        """Left stick (analog) or D-pad for the given role; (0, 0) if no controller."""
        j = pad_for(role)
        if j is None:
            return 0.0, 0.0
        x = y = 0.0
        try:
            if j.get_numaxes() >= 2:
                x, y = j.get_axis(0), j.get_axis(1)
            if abs(x) < PAD_DEAD:
                x = 0.0
            if abs(y) < PAD_DEAD:
                y = 0.0
            if j.get_numhats() > 0:
                hx, hy = j.get_hat(0)
                if hx:
                    x = float(hx)
                if hy:
                    y = float(-hy)
        except Exception:
            return 0.0, 0.0
        m = math.hypot(x, y)
        if m > 1.0:
            x, y = x / m, y / m
        return x, y

    def pad_aim(j, unit, enemies, fallback_angle):
        """Right stick aims. With the stick idle: AI modes aim at the nearest enemy,
        Mongoose vs Viper shoots straight ahead (no auto-aim for either player)."""
        try:
            if j.get_numaxes() >= 4:
                rx, ry = j.get_axis(2), j.get_axis(3)
                if math.hypot(rx, ry) > 0.5:
                    return unit.x + rx * 200, unit.y + ry * 200
        except Exception:
            pass
        alive = [e for e in enemies if e.hp > 0]
        if game_mode != 3 and alive:
            e = min(alive, key=lambda e: math.hypot(e.x - unit.x, e.y - unit.y))
            return e.x, e.y
        return unit.x + math.cos(fallback_angle) * 200, unit.y + math.sin(fallback_angle) * 200

    def pad_held(role):
        """True while the shoot button (A / X) is held on that role's controller."""
        j = pad_for(role)
        if j is None:
            return False
        try:
            return any(j.get_button(b) for b in PAD_SHOOT if b < j.get_numbuttons())
        except Exception:
            return False

    def add_input(a, b):
        return max(-1.0, min(1.0, a + b))

    def show_banner(text):
        banner["text"] = text
        banner["timer"] = 170

    def attack_sound(tool):
        play_sfx(get_attack_sfx(tool, game_mode, level_state["level"]))

    def next_mode():
        nonlocal game_mode
        game_mode = (game_mode % len(MODE_NAMES)) + 1
        pvp_wins["mongoose"] = pvp_wins["viper"] = 0
        viper_team["score"] = 0
        reset_game(level_state["level"])

    def build_players(level):
        if game_mode in (3, 4):
            new = [SquirrelPlayer(220, HEIGHT // 2, player_id=1, level=level)]
        elif game_mode == 5:
            new = [SquirrelPlayer(220, HEIGHT // 2 - 110, player_id=1, level=level),
                   SquirrelPlayer(220, HEIGHT // 2 + 110, player_id=2, level=level)]
        else:
            new = [SquirrelPlayer(WIDTH // 2 - 40, HEIGHT // 2, player_id=1, level=level)]
            if game_mode == 2:
                new.append(SquirrelPlayer(WIDTH // 2 + 40, HEIGHT // 2, player_id=2, level=level))
        for p in new:
            p.is_ai = game_mode not in SQUIRREL_HUMAN_MODES
        players[:] = new

    def start_level(level, message=None):
        """Everyone starts the level refilled. Level growth is the same for both sides;
        humans playing against AI get +10% on top (HP, DEF, ATK, speed)."""
        stop_all_sound()
        level = max(1, level)
        level_state["level"] = level
        pack = pack_size(level, len(players))
        squirrels_get_edge = game_mode in (1, 2)
        for i, p in enumerate(players):
            p.apply_level_up(level, power_mult=pack, human_edge=squirrels_get_edge)
            if game_mode in (3, 4):
                p.x, p.y = 220.0, float(HEIGHT // 2)
            elif game_mode == 5:
                p.x, p.y = 220.0, float(HEIGHT // 2 + (-110 if i == 0 else 110))
        vipers.clear()
        reserve.clear()
        projectiles.clear()
        shards.clear()
        bursts.clear()
        after_burst["action"] = None
        wave_state["pending"] = True
        s = level_stats(level)
        if message is None:
            plural = "S" if pack > 1 else ""
            if game_mode in (4, 5):
                message = (f"LEVEL {level}  |  YOU LEAD {pack} VIPER{plural} PER AI MONGOOSE  |  AI MONGOOSE POWER x{pack}"
                           f"  |  YOUR VIPER +10% (HUMAN vs AI)")
            elif game_mode == 3:
                message = f"LEVEL {level}  |  {pack} VIPER{plural} PER MONGOOSE  |  MONGOOSE POWER x{pack}  |  PLAYER vs PLAYER: EQUAL"
            else:
                message = (f"LEVEL {level}  |  {pack} VIPER{plural} PER MONGOOSE  |  MONGOOSE POWER x{pack}"
                           f"  |  YOUR MONGOOSE +10% (HUMAN vs AI)")
        show_banner(message)

    def reset_game(level):
        nonlocal game_over
        build_players(level)
        level_state["kills"] = 0
        start_level(level)
        game_over = False

    def spawn_wave():
        """A full pack for every mongoose. The mongoose's power multiplier matches the pack size.
        Human-steered pack leaders: P2 in mode 3 (equal), P1 in mode 4, P1 + P2 in mode 5 (+10% vs AI).
        The pack waits in the holes; only one viper per mongoose comes out to fight at a time
        (user, 2026-10-10), the next one when it is beaten."""
        level = level_state["level"]
        pack = pack_size(level, len(players))
        alive = max(1, sum(1 for p in players if p.hp > 0))
        total = pack if game_mode in (3, 4) else pack * alive
        leaders = {3: [2], 4: [1], 5: [1, 2]}.get(game_mode, [])
        reserve[:] = [leaders[i] if i < len(leaders) else None for i in range(total)]
        release_vipers()

    def fighting_slots():
        """How many vipers may be out of the holes at once: one per mongoose still fighting."""
        alive = sum(1 for p in players if p.hp > 0)
        return 2 if game_mode in (2, 5) and alive >= 2 else 1

    def pick_hole():
        """A hole well away from every mongoose (so a viper never pops out right on top of one)."""
        live = [p for p in players if p.hp > 0]
        far = [h for h in HOLES if all(math.hypot(h[0] - p.x, h[1] - p.y) > 280 for p in live)]
        if far:
            return random.choice(far)
        return max(HOLES, key=lambda h: min((math.hypot(h[0] - p.x, h[1] - p.y) for p in live), default=0))

    def release_vipers():
        level = level_state["level"]
        while reserve and len(vipers) < fighting_slots():
            ctrl = reserve.pop(0)
            hole = pick_hole()
            vipers.append(ViperEnemy(level=level, spawn=hole, controller=ctrl, hole=hole,
                                     human_edge=bool(ctrl) and game_mode in VS_AI_MODES))

    def viper_for(ctrl):
        """The viper that player `ctrl` (1 or 2) is steering right now (None if none)."""
        for v in vipers:
            if v.controller == ctrl:
                return v
        return None

    def pvp_viper():
        return viper_for(2)

    def promote_leaders():
        # If a human's viper falls, that player takes over the next viper in the pack
        needed = {3: [2], 4: [1], 5: [1, 2]}.get(game_mode, [])
        for ctrl in needed:
            if viper_for(ctrl) is None:
                spare = [v for v in vipers if not v.controller]
                if spare:
                    nxt = spare[0]
                    nxt.controller = ctrl
                    nxt.is_player_controlled = True
                    if game_mode in VS_AI_MODES:
                        nxt.grant_human_edge()
                    nxt.apply_speed()
                    show_banner(f"PLAYER {ctrl} NOW CONTROLS THE NEXT VIPER IN THE PACK")

    def promote_pvp_leader():
        promote_leaders()

    def vipers_win_round():
        # Viper modes: every AI squirrel beaten -> viper team scores and moves up a level
        viper_team["score"] += 500 * level_state["level"]
        start_level(level_state["level"] + 1,
                    f"VIPERS WIN!  AI MONGOOSE{'S' if len(players) > 1 else ''} DEFEATED  |  NEXT: LEVEL {level_state['level'] + 1}")

    def squirrel_ai(p):
        """AI mongoose (Viper modes): closes in, circles, dodges venom, grabs eggs,
        and bites / uses Fury with the same attacks and rate as a human mongoose."""
        p.update()
        live = [v for v in vipers if v.hp > 0]
        if not live:
            return
        t = min(live, key=lambda v: math.hypot(v.x - p.x, v.y - p.y))
        dist = math.hypot(t.x - p.x, t.y - p.y)
        ang = math.atan2(t.y - p.y, t.x - p.x)
        mvx = mvy = 0.0
        if dist < 70:
            mvx, mvy = -math.cos(ang), -math.sin(ang)
        elif dist > 130:
            mvx, mvy = math.cos(ang), math.sin(ang)
        p.ai_t += 0.025
        side = 1 if math.sin(p.ai_t) > 0 else -1
        mvx += -math.sin(ang) * 0.7 * side
        mvy += math.cos(ang) * 0.7 * side
        for pr in projectiles:
            if pr.is_hostile:
                d = math.hypot(pr.x - p.x, pr.y - p.y)
                if d < 150:
                    mvx += -pr.vy / pr.speed * 0.9
                    mvy += pr.vx / pr.speed * 0.9
                    break
        if shards and p.boost_timer <= 0:
            s = min(shards, key=lambda s: math.hypot(s.x - p.x, s.y - p.y))
            ds = math.hypot(s.x - p.x, s.y - p.y)
            if ds < 300 and dist > 180:
                mvx, mvy = (s.x - p.x) / ds, (s.y - p.y) / ds
        # stay off the walls
        if p.x < 110: mvx += 0.8
        if p.x > WIDTH - 110: mvx -= 0.8
        if p.y < 130: mvy += 0.8
        if p.y > HEIGHT - 130: mvy -= 0.8
        m = math.hypot(mvx, mvy)
        if m > 1.0:
            mvx, mvy = mvx / m, mvy / m
        p.move(mvx, mvy)
        p.aim_angle = ang
        p.ai_fire_wait -= 1
        if viper_part_near(t, p.x, p.y, FURY_RADIUS) == "head" and p.special_timer <= 0:
            squirrel_nova(p)
        elif p.ai_fire_wait <= 0 and dist < BITE_LUNGE + BITE_REACH:
            p.ai_fire_wait = p.shot_cd * 3 + random.randint(0, 20)
            squirrel_shot(p, t.x, t.y)

    def squirrel_shot(p, tx, ty):
        """Bite (user, 2026-10-10: natural fighting, no lasers): the mongoose leaps at the target
        with its jaws open. One bite per leap: head = full attack power, body or tail = half."""
        if p.lunge_t <= 0 and p.try_shot():
            p.start_bite(tx, ty)
            attack_sound("sq1_shot" if p.player_id == 1 else "sq2_shot")

    def viper_part_near(v, x, y, radius):
        """'head', 'body' or None: which part of viper v is within radius of (x, y)."""
        if math.hypot(x - v.x, y - v.y) < radius:
            return "head"
        for sx, sy, _r, _i in v.segment_points():
            if math.hypot(x - sx, y - sy) < radius * 0.75:
                return "body"
        return None

    def squirrel_nova(p):
        """Fury: a whirl of bites in a cloud of dust. Every viper within FURY_RADIUS is bitten:
        head close = 2x attack power, only body or tail close = 1x."""
        if p.try_special():
            p.fury_t = FURY_FRAMES
            for v in vipers:
                part = viper_part_near(v, p.x, p.y, FURY_RADIUS)
                if part:
                    v.take_damage(p.power() * (2 if part == "head" else 1))
                    v.last_hit_by = p
                    for _ in range(8):
                        particles.append(Particle(v.x, v.y, (200, 40, 50)))
            for _ in range(16):
                particles.append(Particle(p.x, p.y, (140, 115, 80)))
            attack_sound("sq1_nova" if p.player_id == 1 else "sq2_nova")

    def viper_spit(v, tx, ty):
        """Spit venom, or, with a mongoose within STRIKE_RANGE, strike it with the head instead."""
        if v.strike_t > 0:
            return
        near = [p for p in players if p.hp > 0 and math.hypot(p.x - v.x, p.y - v.y) < STRIKE_RANGE]
        if near and v.try_shot():
            t = min(near, key=lambda p: math.hypot(p.x - v.x, p.y - v.y))
            v.start_strike(t.x, t.y)
            attack_sound("vp_bite")
        elif v.try_shot():
            projectiles.append(Projectile(v.x, v.y, tx, ty, damage=v.power(), color=(200, 215, 70), is_hostile=True, owner=v))
            attack_sound("vp_spit")

    def viper_burst(v):
        """Venom spray (natural, replaces the old ring): 3 drops in a narrow fan at the nearest mongoose."""
        if v.try_special():
            live = [p for p in players if p.hp > 0]
            if live:
                t = min(live, key=lambda p: math.hypot(p.x - v.x, p.y - v.y))
                aim = math.atan2(t.y - v.y, t.x - v.x)
            else:
                aim = v.heading
            for k in (-1, 0, 1):
                a = aim + k * math.radians(12)
                projectiles.append(Projectile(v.x, v.y, v.x + math.cos(a) * 200, v.y + math.sin(a) * 200,
                                              damage=v.power(), color=(200, 215, 70), is_hostile=True, owner=v))
            attack_sound("vp_burst")

    def update_high_score(score):
        nonlocal high_score
        if score > high_score:
            high_score = score
            save_stored_high_score(high_score)

    def pvp_round_over(winner):
        pvp_wins[winner] += 1
        start_level(level_state["level"] + 1,
                    f"{winner.upper()} WINS THE ROUND!  NEXT: LEVEL {level_state['level'] + 1}  (both sides refilled, equal total power)")

    def viper_defeated(viper):
        if viper in vipers:
            vipers.remove(viper)
        # 2026-09-29: the viper bursts into pieces (head + every segment); a new pack, a level-up
        # or a round change waits until the pieces have faded (see after_burst in the loop).
        bursts.extend(viper.burst_pieces())
        bursts.append(BurstFlash(viper.x, viper.y))
        if game_mode == 3:
            if not vipers and not reserve:
                after_burst["action"] = lambda: pvp_round_over("mongoose")      # whole pack beaten
            else:
                promote_pvp_leader()
            return
        if game_mode in (4, 5):
            promote_leaders()                   # human takes the next viper; no vipers left = game over
            return
        if random.random() < 0.40:
            shards.append(Shard(viper.x, viper.y))
        killer = viper.last_hit_by if viper.last_hit_by in players else players[0]
        killer.score += 250
        killer.kills += 1
        update_high_score(killer.score)
        level_state["kills"] += 1
        if level_state["kills"] % 5 == 0:
            next_level = level_state["level"] + 1
            after_burst["action"] = lambda: start_level(next_level)
        elif not vipers and not reserve:
            # Wave cleared: everyone alive refills before the next full pack arrives
            for p in players:
                if p.hp > 0:
                    p.refill()

    reset_game(1)

    # Level-jump bar along the bottom: LV 1, 10, 20 ... 100
    level_jumps = [1] + list(range(10, 101, 10))
    btn_w, btn_gap = 58, 6
    strip_x = WIDTH // 2 - (len(level_jumps) * (btn_w + btn_gap) - btn_gap) // 2 + 60
    level_buttons = [(lvl, pygame.Rect(strip_x + i * (btn_w + btn_gap), HEIGHT - 66, btn_w, 22)) for i, lvl in enumerate(level_jumps)]

    def draw_level_bar(current_level):
        lbl = font_hud.render("JUMP TO LEVEL:", True, (255, 205, 50))
        canvas.blit(lbl, (level_buttons[0][1].x - lbl.get_width() - 10, HEIGHT - 63))
        for lvl, r in level_buttons:
            active = (current_level // 10 * 10 if current_level >= 10 else 1) == lvl
            pygame.draw.rect(canvas, (255, 205, 50) if active else (30, 40, 70), r, border_radius=4)
            pygame.draw.rect(canvas, (255, 230, 120), r, 1, border_radius=4)
            t = font_hud_sm.render(f"LV {lvl}", True, (20, 20, 30) if active else (230, 230, 230))
            canvas.blit(t, t.get_rect(center=r.center))
        hint = font_hud_sm.render("keys 1-9 = LV 10-90, 0 = LV 100, [ ] = -/+10", True, (160, 170, 200))
        canvas.blit(hint, hint.get_rect(center=((level_buttons[0][1].x + level_buttons[-1][1].right) // 2, HEIGHT - 76)))

    font_help_title = pygame.font.SysFont("arial", 34, bold=True)
    font_help_head = pygame.font.SysFont("consolas", 17, bold=True)
    font_help = pygame.font.SysFont("consolas", 14, bold=True)

    HELP_CONTROLS = [
        ("PLAYER 1  (mongoose in modes 1-3, lead viper in 4-5)", None),
        ("W A S D", "move"),
        ("SPACE / LEFT CLICK", "bite / strike or spit (aim with mouse, HOLD to keep going)"),
        ("E / RIGHT CLICK", "special: Fury of bites / venom spray"),
        ("PLAYER 2  (mongoose 2 in mode 2, viper in modes 3 and 5)", None),
        ("ARROW KEYS", "move (a viper player steers the lead viper)"),
        ("ENTER / RIGHT CTRL", "mongoose bite  /  viper strike or spit"),
        ("RIGHT SHIFT", "mongoose Fury  /  viper venom spray"),
        ("GAME CONTROLLER  (pad 1 = Player 1, pad 2 = Player 2)", None),
        ("LEFT STICK / D-PAD", "move"),
        ("A / X", "bite / strike, hold to keep going (right stick aims)"),
        ("B / Y / LB / RB", "special: Fury / venom spray"),
        ("START", "start the game / show this screen"),
        ("GAME", None),
        ("T  R  M  H", "5 modes / restart / mute / this screen"),
        ("LEVEL JUMP", None),
        ("1 - 9  /  0", "level 10, 20 ... 90  /  level 100"),
        ("] [  or  PAGE UP / DOWN", "next / previous level ending in 0"),
        ("CLICK  LV 1 ... LV 100", "buttons at the bottom of the screen"),
    ]
    HELP_RULES = [
        "5 MODES  (press T)",
        "1 Mongoose vs AI       2 Two mongooses vs AI",
        "3 Mongoose vs Viper (player vs player)",
        "4 Viper vs AI mongoose 5 Two vipers vs AI mongooses",
        "",
        "FAIR POWER",
        "- Same level stats and same growth for both sides.",
        "- Packs: 1 viper per mongoose at levels 1-5, +1 every",
        "  5 levels (max 10). Mongoose gets power x pack size:",
        "  more HP, DEF and bite power. One viper at a time",
        "  comes out of the holes to fight each mongoose.",
        "- HUMAN vs AI (modes 1, 2, 4, 5): the human player",
        "  gets +10% health, defense, attack and speed.",
        "- Player vs player (mode 3): exactly equal.",
        "",
        "PLAYING",
        "- Kill 5 vipers = next level. Beat a whole pack, or",
        "  the AI mongoose(s) = everyone refills, next pack.",
        "- Touching hurts both. Eggs: +25% attack for 10s.",
        "- If your viper falls, you take over the next one.",
        "",
        "TOUCH: drag left side = move, hold BITE (auto-aim),",
        "  tap FURY; MODE / HELP / MUTE next to the level bar.",
        "SOUND: only attacks make sound (each has its tune).",
    ]

    def draw_help_screen(current_level):
        overlay = pygame.Surface((WIDTH, HEIGHT), pygame.SRCALPHA)
        overlay.fill((6, 8, 18, 238))
        canvas.blit(overlay, (0, 0))
        title = font_help_title.render(GAME_NAME, True, (255, 205, 50))
        canvas.blit(title, title.get_rect(center=(WIDTH // 2, 34)))
        m = font_help_head.render(f"MODE {game_mode}:  {MODE_NAMES[game_mode]}   (press T / MODE to change)      LEVEL: {current_level}", True, (0, 255, 220))
        canvas.blit(m, m.get_rect(center=(WIDTH // 2, 70)))

        # Left column: every key
        x, y = 50, 100
        canvas.blit(font_help_head.render("ALL KEYS", True, (255, 205, 50)), (x, y))
        y += 26
        for key, what in HELP_CONTROLS:
            if what is None:
                y += 4
                canvas.blit(font_help.render(key, True, (120, 200, 255)), (x, y))
            else:
                canvas.blit(font_help.render(key, True, (255, 255, 255)), (x + 12, y))
                canvas.blit(font_help.render(what, True, (190, 200, 220)), (x + 230, y))
            y += 21

        # Right column: how it works
        x, y = 690, 100
        canvas.blit(font_help_head.render("HOW IT WORKS", True, (255, 205, 50)), (x, y))
        y += 26
        for line in HELP_RULES:
            heading = line and not line.startswith(("-", " "))
            col = (120, 200, 255) if heading else (190, 200, 220)
            if line:
                canvas.blit(font_help.render(line, True, col), (x, y))
            y += 21

        go = font_help_head.render("PRESS ENTER / SPACE, CLICK, TAP, OR START ON A CONTROLLER TO PLAY", True, (80, 255, 120))
        canvas.blit(go, go.get_rect(center=(WIDTH // 2, HEIGHT - 14)))

    # ---- Touch controls (phones / tablets). Hidden until the screen is touched. ----
    # On phones (auto-detected, or the ?mobile link) the controls are shown from the start, bigger and brighter
    MOBILE = detect_mobile()
    touch = {"on": MOBILE, "stick_id": None, "origin": (0.0, 0.0), "vec": (0.0, 0.0), "fire_ids": set(), "finger_seen": False}
    if MOBILE:
        TOUCH_STICK_C, TOUCH_STICK_R = (190, HEIGHT - 235), 125
        TOUCH_FIRE_C, TOUCH_FIRE_R = (WIDTH - 175, HEIGHT - 250), 105
        TOUCH_NOVA_C, TOUCH_NOVA_R = (WIDTH - 395, HEIGHT - 165), 70
    else:
        TOUCH_STICK_C, TOUCH_STICK_R = (170, HEIGHT - 200), 95
        TOUCH_FIRE_C, TOUCH_FIRE_R = (WIDTH - 150, HEIGHT - 210), 72
        TOUCH_NOVA_C, TOUCH_NOVA_R = (WIDTH - 300, HEIGHT - 150), 50
    font_touch_big = pygame.font.SysFont("arial", 34 if MOBILE else 22, bold=True)
    font_touch_small = pygame.font.SysFont("arial", 18 if MOBILE else 13, bold=True)
    TOUCH_MODE_BTN = pygame.Rect(level_buttons[-1][1].right + 10, HEIGHT - 66, 70, 22)
    TOUCH_HELP_BTN = pygame.Rect(TOUCH_MODE_BTN.right + 6, HEIGHT - 66, 58, 22)
    TOUCH_MUTE_BTN = pygame.Rect(TOUCH_HELP_BTN.right + 6, HEIGHT - 66, 58, 22)

    def tap_rect(r):
        """Small on-screen buttons get a taller tap area on phones (fingers are bigger than a mouse)."""
        return r.inflate(4, 26) if MOBILE else r

    def touch_aim(unit, enemies):
        """FIRE button aims at the nearest enemy in AI modes, straight ahead in Mongoose vs Viper."""
        alive = [e for e in enemies if e.hp > 0]
        if game_mode != 3 and alive:
            e = min(alive, key=lambda e: math.hypot(e.x - unit.x, e.y - unit.y))
            return e.x, e.y
        ang = getattr(unit, "aim_angle", getattr(unit, "heading", 0.0))
        return unit.x + math.cos(ang) * 200, unit.y + math.sin(ang) * 200

    def p1_unit():
        """What player 1 is playing: the mongoose, or (Viper modes) their lead viper."""
        return viper_for(1) if game_mode in (4, 5) else players[0]

    def p1_attack(tx, ty):
        if game_mode in (4, 5):
            v = viper_for(1)
            if v:
                viper_spit(v, tx, ty)
        elif players[0].hp > 0:
            squirrel_shot(players[0], tx, ty)

    def p1_special():
        if game_mode in (4, 5):
            v = viper_for(1)
            if v:
                viper_burst(v)
        else:
            squirrel_nova(players[0])

    def draw_touch_controls(big=True):
        ui = pygame.Surface((WIDTH, HEIGHT), pygame.SRCALPHA)
        if not big:
            draw_small_touch_buttons()
            return
        # Joystick: appears where the left thumb lands
        base = touch["origin"] if touch["stick_id"] is not None else TOUCH_STICK_C
        knob = (base[0] + touch["vec"][0] * TOUCH_STICK_R, base[1] + touch["vec"][1] * TOUCH_STICK_R)
        pygame.draw.circle(ui, (0, 229, 212, 60), base, TOUCH_STICK_R)
        pygame.draw.circle(ui, (0, 229, 212, 200), base, TOUCH_STICK_R, 4)
        pygame.draw.circle(ui, (0, 229, 212, 210), knob, int(TOUCH_STICK_R * 0.38))
        # FIRE (hold): solid, bright and always clearly visible
        firing = bool(touch["fire_ids"])
        pygame.draw.circle(ui, (255, 60, 60, 70), TOUCH_FIRE_C, TOUCH_FIRE_R + 14)                    # glow
        pygame.draw.circle(ui, (255, 70, 70, 255) if firing else (225, 40, 55, 235), TOUCH_FIRE_C, TOUCH_FIRE_R)
        pygame.draw.circle(ui, (255, 255, 255, 255), TOUCH_FIRE_C, TOUCH_FIRE_R, 5)
        # NOVA (special) - fills up as the cooldown recharges
        p1 = p1_unit() or players[0]
        ready = 1.0 - (p1.special_timer / p1.special_cd) if p1.special_cd else 1.0
        pygame.draw.circle(ui, (0, 200, 140, 235) if p1.special_timer == 0 else (0, 110, 80, 200), TOUCH_NOVA_C, TOUCH_NOVA_R)
        pygame.draw.circle(ui, (255, 255, 255, 255), TOUCH_NOVA_C, TOUCH_NOVA_R, 4)
        if p1.special_timer > 0:
            pygame.draw.arc(ui, (120, 255, 200, 255), pygame.Rect(TOUCH_NOVA_C[0] - TOUCH_NOVA_R, TOUCH_NOVA_C[1] - TOUCH_NOVA_R, TOUCH_NOVA_R * 2, TOUCH_NOVA_R * 2),
                            math.pi / 2, math.pi / 2 + ready * 2 * math.pi, 7)
        canvas.blit(ui, (0, 0))
        for text, sub, center in (("BITE", "hold", TOUCH_FIRE_C), ("FURY", "tap" if p1.special_timer == 0 else "charging", TOUCH_NOVA_C)):
            t = font_touch_big.render(text, True, (255, 255, 255))
            canvas.blit(t, t.get_rect(center=(center[0], center[1] - 6)))
            s = font_touch_small.render(sub, True, (255, 235, 235))
            canvas.blit(s, s.get_rect(center=(center[0], center[1] + t.get_height() // 2 + 4)))
        mv = font_touch_small.render("MOVE", True, (180, 255, 245))
        canvas.blit(mv, mv.get_rect(center=(base[0], base[1] + TOUCH_STICK_R + 16)))
        draw_small_touch_buttons()

    def draw_small_touch_buttons():
        # Small tap buttons next to the level bar
        for rect, label in ((TOUCH_MODE_BTN, "MODE"), (TOUCH_HELP_BTN, "HELP"), (TOUCH_MUTE_BTN, "UNMUTE" if audio_muted else "MUTE")):
            pygame.draw.rect(canvas, (30, 40, 70), rect, border_radius=4)
            pygame.draw.rect(canvas, (0, 229, 212), rect, 1, border_radius=4)
            t = font_hud_sm.render(label, True, (230, 255, 250))
            canvas.blit(t, t.get_rect(center=rect.center))

    running = True
    while running:
        current_level = level_state["level"]

        # Mode or level tier changed: pre-build attack tunes so the first shot doesn't stutter
        wanted_key = (game_mode, sound_tier(current_level))
        if wanted_key != tune_key:
            tune_key = wanted_key
            for tool in ATTACK_TUNES:
                get_attack_sfx(tool, game_mode, current_level)

        for event in pygame.event.get():
            # Touch screens also send fake mouse clicks for every finger; the finger events handle touch
            if event.type in (pygame.MOUSEBUTTONDOWN, pygame.MOUSEBUTTONUP, pygame.MOUSEMOTION) and getattr(event, "touch", False):
                continue
            # Phones whose browser reports taps only as mouse clicks: treat the mouse as a finger
            if (MOBILE and not touch["finger_seen"] and event.type in (pygame.MOUSEBUTTONDOWN, pygame.MOUSEBUTTONUP, pygame.MOUSEMOTION)
                    and getattr(event, "button", 1) == 1):
                if event.type == pygame.MOUSEMOTION and not event.buttons[0]:
                    continue
                ftype = {pygame.MOUSEBUTTONDOWN: pygame.FINGERDOWN, pygame.MOUSEBUTTONUP: pygame.FINGERUP,
                         pygame.MOUSEMOTION: pygame.FINGERMOTION}[event.type]
                event = pygame.event.Event(ftype, x=event.pos[0] / WIDTH, y=event.pos[1] / HEIGHT, finger_id=-1, from_mouse=True)
            if event.type in (pygame.FINGERDOWN, pygame.FINGERMOTION) and not getattr(event, "from_mouse", False):
                touch["finger_seen"] = True

            if event.type == pygame.QUIT:
                running = False

            # ---- Touch screen (phone / tablet) ----
            elif event.type == pygame.FINGERDOWN:
                touch["on"] = True
                tx, ty = event.x * WIDTH, event.y * HEIGHT
                fid = event.finger_id
                if tap_rect(TOUCH_MODE_BTN).collidepoint(tx, ty):
                    next_mode()

                elif tap_rect(TOUCH_HELP_BTN).collidepoint(tx, ty):
                    show_help = not show_help
                elif tap_rect(TOUCH_MUTE_BTN).collidepoint(tx, ty):
                    audio_muted = not audio_muted
                    if audio_muted:
                        stop_all_sound()
                elif show_help:
                    show_help = False
                elif any(tap_rect(r).collidepoint(tx, ty) for _, r in level_buttons):
                    for lvl, r in level_buttons:
                        if tap_rect(r).collidepoint(tx, ty):
                            start_level(lvl)
                            game_over = False
                            break
                elif game_over:
                    reset_game(current_level)
                elif math.hypot(tx - TOUCH_NOVA_C[0], ty - TOUCH_NOVA_C[1]) < TOUCH_NOVA_R * 1.3:
                    p1_special()
                elif tx < WIDTH / 2:
                    touch["stick_id"] = fid
                    touch["origin"] = (tx, ty)
                    touch["vec"] = (0.0, 0.0)
                else:
                    touch["fire_ids"].add(fid)

            elif event.type == pygame.FINGERMOTION:
                if event.finger_id == touch["stick_id"]:
                    ox_, oy_ = touch["origin"]
                    vx_ = (event.x * WIDTH - ox_) / TOUCH_STICK_R
                    vy_ = (event.y * HEIGHT - oy_) / TOUCH_STICK_R
                    m = math.hypot(vx_, vy_)
                    if m < 0.15:
                        vx_ = vy_ = 0.0
                    elif m > 1.0:
                        vx_, vy_ = vx_ / m, vy_ / m
                    touch["vec"] = (vx_, vy_)

            elif event.type == pygame.FINGERUP:
                touch["fire_ids"].discard(event.finger_id)
                if event.finger_id == touch["stick_id"]:
                    touch["stick_id"] = None
                    touch["vec"] = (0.0, 0.0)

            # Start / help screen: T changes mode, M mutes, anything else starts the game
            elif show_help and event.type in (pygame.KEYDOWN, pygame.MOUSEBUTTONDOWN):
                if event.type == pygame.KEYDOWN and event.key == pygame.K_t:
                    next_mode()

                elif event.type == pygame.KEYDOWN and event.key == pygame.K_m:
                    audio_muted = not audio_muted
                    if audio_muted:
                        stop_all_sound()
                else:
                    show_help = False

            elif event.type == pygame.KEYDOWN:
                if event.key == pygame.K_m:
                    audio_muted = not audio_muted
                    if audio_muted:
                        stop_all_sound()

                elif event.key == pygame.K_h:
                    show_help = True

                elif event.key == pygame.K_t:
                    next_mode()


                elif event.key == pygame.K_r:
                    reset_game(current_level)

                elif pygame.K_1 <= event.key <= pygame.K_9:
                    start_level((event.key - pygame.K_0) * 10)
                    game_over = False

                elif event.key == pygame.K_0:
                    start_level(100)
                    game_over = False

                elif event.key == pygame.K_RIGHTBRACKET or event.key == pygame.K_PAGEUP:
                    start_level(((current_level // 10) + 1) * 10)
                    game_over = False

                elif event.key == pygame.K_LEFTBRACKET or event.key == pygame.K_PAGEDOWN:
                    start_level(max(1, ((current_level - 1) // 10) * 10))
                    game_over = False

                elif game_over:
                    pass

                # Co-op Player 2 (arrows + ENTER blaster + RSHIFT nova)
                elif game_mode == 2 and event.key in (pygame.K_RETURN, pygame.K_RCTRL):
                    p2 = players[1]
                    squirrel_shot(p2, p2.x + (150 if p2.facing_right else -150), p2.y)
                elif game_mode == 2 and event.key == pygame.K_RSHIFT:
                    squirrel_nova(players[1])

                # Player 2's viper (modes 3 and 5): arrows + RCTRL/ENTER spit in its heading + RSHIFT burst
                elif game_mode in (3, 5) and event.key in (pygame.K_RCTRL, pygame.K_KP0, pygame.K_RETURN):
                    v = pvp_viper()
                    if v:
                        viper_spit(v, v.x + math.cos(v.heading) * 150, v.y + math.sin(v.heading) * 150)
                elif game_mode in (3, 5) and event.key == pygame.K_RSHIFT:
                    v = pvp_viper()
                    if v:
                        viper_burst(v)

                # Player 1 (squirrel, or their viper in modes 4 / 5)
                elif event.key == pygame.K_SPACE:
                    mx, my = pygame.mouse.get_pos()
                    p1_attack(mx, my)
                elif event.key == pygame.K_e:
                    p1_special()

            # Level-jump bar: click LV 1 / 10 / 20 ... 100 (works on the game-over screen too)
            elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1 and any(r.collidepoint(event.pos) for _, r in level_buttons):
                for lvl, r in level_buttons:
                    if r.collidepoint(event.pos):
                        start_level(lvl)
                        game_over = False
                        break

            elif event.type == pygame.MOUSEBUTTONDOWN and not game_over:
                if event.button == 1:
                    mx, my = pygame.mouse.get_pos()
                    p1_attack(mx, my)
                elif event.button == 3:
                    p1_special()

            # ---- Game controllers ----
            elif event.type == pygame.JOYDEVICEADDED:
                try:
                    j = pygame.joystick.Joystick(event.device_index)
                    j.init()
                    pads[j.get_instance_id()] = j
                    role = {"p1": "MONGOOSE P1", "p2": "MONGOOSE P2", "viper1": "PLAYER 1's VIPER",
                            "viper": "PLAYER 2's VIPER"}.get(pad_role(j), "nobody in this mode")
                    show_banner(f"GAME CONTROLLER {len(pads)} CONNECTED  ->  controls {role}")
                except Exception:
                    pass

            elif event.type == pygame.JOYDEVICEREMOVED:
                pads.pop(getattr(event, "instance_id", None), None)
                show_banner("GAME CONTROLLER DISCONNECTED")

            elif event.type == pygame.JOYBUTTONDOWN:
                j = pads.get(getattr(event, "instance_id", getattr(event, "joy", None)))
                if j is None:
                    continue
                btn = event.button
                if show_help:
                    if btn == PAD_START or btn in PAD_SHOOT:
                        show_help = False
                    continue
                if btn == PAD_START:
                    show_help = True
                    continue
                if game_over:
                    if btn in PAD_SHOOT:
                        reset_game(current_level)
                    continue
                role = pad_role(j)
                if role == "p1" or (role == "p2" and len(players) > 1):
                    p = players[0] if role == "p1" else players[1]
                    if btn in PAD_SHOOT:
                        tx, ty = pad_aim(j, p, vipers, p.aim_angle)
                        squirrel_shot(p, tx, ty)
                    elif btn in PAD_SPECIAL:
                        squirrel_nova(p)
                elif role in ("viper", "viper1"):
                    v = viper_for(1 if role == "viper1" else 2)
                    if v:
                        if btn in PAD_SHOOT:
                            tx, ty = pad_aim(j, v, players, v.heading)
                            viper_spit(v, tx, ty)
                        elif btn in PAD_SPECIAL:
                            viper_burst(v)

        if not game_over and not show_help:
            keys = pygame.key.get_pressed()

            # AI squirrels (Viper modes 4 and 5)
            if game_mode not in SQUIRREL_HUMAN_MODES:
                for p in players:
                    if p.hp > 0:
                        squirrel_ai(p)

            # P1 Controls (WASD + controller 1) - squirrel modes
            if game_mode in SQUIRREL_HUMAN_MODES and players[0].hp > 0:
                jx, jy = pad_move("p1")
                jx, jy = add_input(jx, touch["vec"][0]), add_input(jy, touch["vec"][1])
                players[0].move(add_input(keys[pygame.K_d] - keys[pygame.K_a], jx), add_input(keys[pygame.K_s] - keys[pygame.K_w], jy))
                players[0].update()

            # P2 Controls (Arrows + controller 2)
            if game_mode == 2 and len(players) > 1 and players[1].hp > 0:
                jx, jy = pad_move("p2")
                players[1].move(add_input(keys[pygame.K_RIGHT] - keys[pygame.K_LEFT], jx), add_input(keys[pygame.K_DOWN] - keys[pygame.K_UP], jy))
                players[1].update()

            # Hold to keep firing (keyboard, mouse or controller A) - the fire rate limit still applies
            mouse_on_bar = any(r.collidepoint(pygame.mouse.get_pos()) for _, r in level_buttons)
            mouse_fire = pygame.mouse.get_pressed()[0] and not mouse_on_bar and not touch["on"]
            p1_role = "viper1" if game_mode in (4, 5) else "p1"
            me = p1_unit()
            if me is not None and me.hp > 0 and (keys[pygame.K_SPACE] or mouse_fire or pad_held(p1_role) or touch["fire_ids"]):
                foes = players if game_mode in (4, 5) else vipers
                j = pad_for(p1_role)
                if j is not None and pad_held(p1_role):
                    tx, ty = pad_aim(j, me, foes, getattr(me, "aim_angle", getattr(me, "heading", 0.0)))
                elif touch["fire_ids"]:
                    tx, ty = touch_aim(me, foes)
                else:
                    tx, ty = pygame.mouse.get_pos()
                p1_attack(tx, ty)
            if game_mode == 2 and len(players) > 1 and players[1].hp > 0 and (keys[pygame.K_RETURN] or keys[pygame.K_RCTRL] or pad_held("p2")):
                p2 = players[1]
                j = pad_for("p2")
                if j is not None and pad_held("p2"):
                    tx, ty = pad_aim(j, p2, vipers, p2.aim_angle)
                else:
                    tx, ty = p2.x + (150 if p2.facing_right else -150), p2.y
                squirrel_shot(p2, tx, ty)
            if game_mode in (3, 5) and (keys[pygame.K_RETURN] or keys[pygame.K_RCTRL] or keys[pygame.K_KP0] or pad_held("viper")):
                v = pvp_viper()
                if v:
                    j = pad_for("viper")
                    if j is not None and pad_held("viper"):
                        tx, ty = pad_aim(j, v, players, v.heading)
                    else:
                        tx, ty = v.x + math.cos(v.heading) * 150, v.y + math.sin(v.heading) * 150
                    viper_spit(v, tx, ty)

            # Next wave: a full viper pack per squirrel (squirrel power already matches the pack).
            # Viper modes: the pack comes once per level (losing it = game over).
            # A beaten viper's burst plays out first (~0.8 s); then any waiting level-up / round
            # change runs, and only then does a new pack appear.
            for b in bursts[:]:
                b.update()
                if b.life <= 0:
                    bursts.remove(b)
            if after_burst["action"] and not bursts:
                action, after_burst["action"] = after_burst["action"], None
                action()
            if not vipers and not reserve and not bursts and not after_burst["action"] and (wave_state["pending"] or game_mode not in (4, 5)):
                spawn_wave()
                wave_state["pending"] = False
            elif reserve and not bursts and not after_burst["action"] and len(vipers) < fighting_slots():
                release_vipers()                # the next viper crawls out of a hole
                if game_mode in (3, 4, 5):
                    promote_leaders()

            for p in projectiles[:]:
                p.update()
                if not p.alive:
                    projectiles.remove(p)

            for part in particles[:]:
                part.update()
                if part.life <= 0:
                    particles.remove(part)

            # Energy shards: whoever grabs one (squirrel OR viper) gets the same boost
            for s in shards[:]:
                s.update()
                if s.life <= 0:
                    shards.remove(s)
                    continue
                for f in [p for p in players if p.hp > 0] + vipers:
                    if math.hypot(s.x - f.x, s.y - f.y) < 26:
                        f.collect_shard()
                        if isinstance(f, SquirrelPlayer):
                            f.score += 100
                            update_high_score(f.score)
                            who = f"MONGOOSE P{f.player_id}"
                        else:
                            who = "VIPER"
                        show_banner(f"{who} POWER UP!  ATK {f.attack_power} -> {f.power()} for 10s")
                        for _ in range(12):
                            particles.append(Particle(f.x, f.y, (255, 230, 90)))
                        shards.remove(s)
                        break

            # New shards appear regularly in every mode, anywhere in the middle of the arena
            shard_clock["t"] += 1
            if shard_clock["t"] >= SHARD_SPAWN_FRAMES and len(shards) < 2:
                shard_clock["t"] = 0
                shards.append(Shard(random.uniform(200, WIDTH - 200), random.uniform(150, HEIGHT - 150)))

            # Move vipers
            for viper in vipers:
                if viper.controller == 1:
                    # Player 1's viper (modes 4 / 5): WASD + controller 1 + touch joystick
                    jx, jy = pad_move("viper1")
                    jx, jy = add_input(jx, touch["vec"][0]), add_input(jy, touch["vec"][1])
                    viper.update_manual(add_input(keys[pygame.K_d] - keys[pygame.K_a], jx), add_input(keys[pygame.K_s] - keys[pygame.K_w], jy))
                elif viper.controller == 2:
                    jx, jy = pad_move("viper")
                    viper.update_manual(add_input(keys[pygame.K_RIGHT] - keys[pygame.K_LEFT], jx), add_input(keys[pygame.K_DOWN] - keys[pygame.K_UP], jy))
                else:
                    viper.update_ai(players, projectiles, viper_spit, viper_burst, shards)

            # Mongoose bites: one per leap, head = full attack power, body or tail = half
            for p in players:
                if p.hp > 0 and p.lunge_t > 0 and not p.bite_done:
                    bx, by = p.bite_point()
                    for viper in vipers:
                        part = viper_part_near(viper, bx, by, BITE_RADIUS)
                        if part:
                            viper.take_damage(p.power() if part == "head" else max(1, p.power() // 2))
                            viper.last_hit_by = p
                            p.bite_done = True
                            for _ in range(7):
                                particles.append(Particle(bx, by, (200, 40, 50)))
                            shake_intensity = max(shake_intensity, 4)
                            break

            # Squirrel shots vs vipers: head = full damage; ANY body or tail segment = half damage
            # (2 body/tail hits = 1 head hit). Until 2026-09-29 only the first 5 segments counted and
            # shots passed straight through the rest of the body and the tail.
            for p in projectiles[:]:
                if p.is_hostile:
                    continue
                for viper in vipers:
                    hit = False
                    if math.hypot(p.x - viper.x, p.y - viper.y) < HIT_RADIUS:
                        hit = True
                        viper.take_damage(p.damage)
                    else:
                        for sx, sy, _r, _i in viper.segment_points():
                            if math.hypot(p.x - sx, p.y - sy) < BODY_HIT_RADIUS:
                                hit = True
                                viper.take_damage(max(1, p.damage // 2))
                                break
                    if hit:
                        viper.last_hit_by = p.owner
                        if p in projectiles:
                            projectiles.remove(p)
                        for _ in range(5):
                            particles.append(Particle(p.x, p.y, (80, 255, 120)))
                        shake_intensity = max(shake_intensity, 3)
                        break

            # Viper venom vs squirrels (same hit size, same damage)
            for p in projectiles[:]:
                if not p.is_hostile:
                    continue
                for ply in players:
                    if ply.hp > 0 and math.hypot(p.x - ply.x, p.y - ply.y) < HIT_RADIUS:
                        ply.take_damage(p.damage)
                        shake_intensity = max(shake_intensity, 6)
                        if p in projectiles:
                            projectiles.remove(p)
                        for _ in range(6):
                            particles.append(Particle(ply.x, ply.y, (255, 80, 120)))
                        break

            # Head strikes: the extended head bites a mongoose once per strike (same damage as a spit)
            for viper in vipers:
                if viper.strike_can_hit():
                    hx, hy = viper.strike_tip()
                    for ply in players:
                        # the head moves ~55 px a frame, so test the whole neck line, not just the tip
                        sx, sy = hx - viper.x, hy - viper.y
                        k = max(0.0, min(1.0, ((ply.x - viper.x) * sx + (ply.y - viper.y) * sy) / (sx * sx + sy * sy or 1.0)))
                        if ply.hp > 0 and math.hypot(viper.x + sx * k - ply.x, viper.y + sy * k - ply.y) < STRIKE_HIT_RADIUS:
                            ply.take_damage(viper.power())
                            viper.strike_hit = True
                            shake_intensity = max(shake_intensity, 8)
                            for _ in range(8):
                                particles.append(Particle(hx, hy, (255, 60, 90)))
                            break

            # Body contact: BOTH sides take a hit (fair clash)
            for viper in vipers:
                for ply in players:
                    if ply.hp > 0 and viper.contact_timer <= 0 and math.hypot(viper.x - ply.x, viper.y - ply.y) < CONTACT_RADIUS:
                        ply.take_damage(viper.power())
                        viper.take_damage(ply.power())
                        viper.last_hit_by = ply
                        viper.contact_timer = 40
                        attack_sound("vp_bite")
                        shake_intensity = max(shake_intensity, 9)
                        for _ in range(8):
                            particles.append(Particle((ply.x + viper.x) / 2, (ply.y + viper.y) / 2, (255, 200, 80)))
                        ang = math.atan2(viper.y - ply.y, viper.x - ply.x)
                        viper.x = max(50, min(WIDTH - 50, viper.x + math.cos(ang) * 60))
                        viper.y = max(50, min(HEIGHT - 50, viper.y + math.sin(ang) * 60))
                        ply.x = max(50, min(WIDTH - 50, ply.x - math.cos(ang) * 30))
                        ply.y = max(50, min(HEIGHT - 50, ply.y - math.sin(ang) * 30))

            # Defeats
            if game_mode == 3 and players[0].hp <= 0:
                pvp_round_over("viper")
            elif game_mode in (4, 5) and all(p.hp <= 0 for p in players):
                vipers_win_round()
            else:
                for viper in vipers[:]:
                    if viper.hp <= 0 and viper in vipers:
                        viper_defeated(viper)

            if game_mode in (1, 2) and all(p.hp <= 0 for p in players):
                game_over = True
                update_high_score(players[0].score)
            if game_mode in (4, 5) and not vipers and not reserve and not wave_state["pending"] and not bursts:
                game_over = True       # the whole viper pack is gone (after its last burst has played)

        # ---------------- RENDER ----------------
        current_level = level_state["level"]
        canvas.blit(ground, (0, 0))          # all play is on the ground (user, 2026-10-10)
        canvas.blit(backdrop, (0, 0))
        world_t["t"] += 1
        busy = [v.hole for v in vipers if v.hole]
        free_holes = [h for h in HOLES if h not in busy]
        for k in range(min(len(reserve), len(free_holes))):      # the rest of the pack, waiting in holes
            draw_peeking_snake(canvas, free_holes[k], world_t["t"], k)
        busy_holes = busy + [s.v.hole for s in wild_snakes if s.v.hole]
        jungle_life(jungle, wild_snakes, wild_fx, particles, jungle_rnd, wild_clock, busy_holes)
        for s in wild_snakes:                                     # wild snakes and mongooses, living on their own
            s.draw(canvas)
        for jm in jungle:
            jm.draw(canvas)
        for piece in wild_fx:
            piece.draw(canvas)

        for s in shards:
            s.draw(canvas)
        for p in projectiles:
            p.draw(canvas)
        for part in particles:
            part.draw(canvas)
        for b in bursts:
            b.draw(canvas)
        for viper in vipers:
            viper.draw(canvas)
        for p in players:
            if p.hp > 0:
                p.draw(canvas)

        if not game_over and not touch["on"]:
            mx, my = pygame.mouse.get_pos()
            pygame.draw.circle(canvas, (0, 255, 230), (mx, my), 7, 1)
            pygame.draw.line(canvas, (0, 255, 230), (mx - 10, my), (mx + 10, my), 1)
            pygame.draw.line(canvas, (0, 255, 230), (mx, my - 10), (mx, my + 10), 1)

        # --- HUD: identical stat panels for squirrel(s) and viper(s) ---
        def draw_panel(x, y, label, unit, hp_color):
            pygame.draw.rect(canvas, (35, 15, 20), (x, y, 200, 12))
            pygame.draw.rect(canvas, hp_color, (x, y, int(200 * max(0.0, unit.hp / unit.max_hp)), 12))
            pygame.draw.rect(canvas, (220, 220, 220), (x, y, 200, 12), 1)
            canvas.blit(font_hud_sm.render(f"{label} HP {unit.hp}/{unit.max_hp}", True, (255, 240, 240)), (x + 5, y))
            pygame.draw.rect(canvas, (15, 25, 40), (x, y + 16, 200, 10))
            pygame.draw.rect(canvas, (0, 215, 255), (x, y + 16, int(200 * max(0.0, unit.defense / unit.max_defense)), 10))
            pygame.draw.rect(canvas, (180, 240, 255), (x, y + 16, 200, 10), 1)
            canvas.blit(font_hud_sm.render(f"DEF {unit.defense}/{unit.max_defense}", True, (210, 255, 255)), (x + 5, y + 15))
            ready = 1.0 - (unit.special_timer / unit.special_cd)
            pygame.draw.rect(canvas, (25, 30, 20), (x, y + 30, 200, 8))
            pygame.draw.rect(canvas, (0, 255, 170) if unit.special_timer == 0 else (120, 160, 90), (x, y + 30, int(200 * ready), 8))
            atk_txt = f"ATK {unit.power()}  POWER UP {unit.boost_timer // 60 + 1}s" if unit.boost_timer > 0 else f"ATK {unit.attack_power}"
            canvas.blit(font_hud_sm.render(atk_txt, True, (255, 240, 120) if unit.boost_timer > 0 else (255, 205, 50)), (x + 5, y + 40))

        edge_tag = lambda u: " +10%" if getattr(u, "human_edge", False) else ""
        for i, p in enumerate(players):
            who = "AI MONGOOSE" if p.is_ai else f"MONGOOSE P{p.player_id}"
            draw_panel(25, 20 + i * 60, f"{who} x{p.power_mult}{edge_tag(p)}", p, (255, 110, 60) if p.player_id == 1 else (90, 170, 255))
        shown = sorted(vipers, key=lambda v: (not v.is_player_controlled, v.controller or 9))[:2]
        for i, v in enumerate(shown):
            who = f"VIPER (P{v.controller})" if v.controller else "VIPER AI"
            draw_panel(WIDTH - 225, 20 + i * 60, who + edge_tag(v), v, (80, 220, 110))
        if len(vipers) > 2:
            more = font_hud_sm.render(f"+ {len(vipers) - 2} more vipers in the pack", True, (160, 230, 170))
            canvas.blit(more, (WIDTH - 225, 20 + 2 * 60))

        top = font_hud.render(f"LEVEL {current_level}  |  MODE {game_mode}: {MODE_NAMES[game_mode]}  [T: SWITCH]", True, (255, 205, 50))
        canvas.blit(top, top.get_rect(center=(WIDTH // 2, 22)))
        if game_mode == 3:
            sc = font_hud.render(f"ROUNDS  MONGOOSE {pvp_wins['mongoose']} - {pvp_wins['viper']} VIPER", True, (230, 230, 230))
        elif game_mode in (4, 5):
            sc = font_hud.render(f"VIPER TEAM SCORE {viper_team['score']}   |   BEAT THE AI MONGOOSE{'S' if len(players) > 1 else ''} TO LEVEL UP", True, (230, 230, 230))
        else:
            sc = font_hud.render(f"SCORE {players[0].score}   HI {high_score}   KILLS TO NEXT LEVEL {5 - level_state['kills'] % 5}", True, (230, 230, 230))
        canvas.blit(sc, sc.get_rect(center=(WIDTH // 2, 42)))

        # Power comparison at this level: level growth is equal; humans vs AI get +10%
        s_now = level_stats(current_level)
        pack_now = pack_size(current_level, len(players))
        pw = font_hud.render(f"VIPERS: {len(vipers)}   |   PACK: {pack_now} VIPER{'S' if pack_now > 1 else ''} PER MONGOOSE   |   MONGOOSE POWER x{pack_now}",
                             True, (80, 255, 120))
        canvas.blit(pw, pw.get_rect(center=(WIDTH // 2, 62)))
        e = HUMAN_EDGE
        sq_hp, sq_def, sq_atk = (s_now[k] * pack_now for k in ("max_hp", "max_defense", "attack_power"))
        vp_hp, vp_def, vp_atk = s_now["max_hp"], s_now["max_defense"], s_now["attack_power"]
        if game_mode in (1, 2):
            txt2 = (f"AI VIPER: HP {vp_hp} DEF {vp_def} ATK {vp_atk}      |      "
                    f"YOUR MONGOOSE x{pack_now} +10%: HP {int(sq_hp * e + 0.5)} DEF {int(sq_def * e + 0.5)} ATK {int(sq_atk * e + 0.5)}")
            txt3, col3 = "HUMAN vs AI: YOUR MONGOOSE HAS +10% HEALTH, DEFENSE, ATTACK AND SPEED", (255, 170, 60)
        elif game_mode in (4, 5):
            txt2 = (f"YOUR VIPER +10%: HP {int(vp_hp * e + 0.5)} DEF {int(vp_def * e + 0.5)} ATK {int(vp_atk * e + 0.5)}      |      "
                    f"AI MONGOOSE x{pack_now}: HP {sq_hp} DEF {sq_def} ATK {sq_atk}")
            txt3, col3 = "HUMAN vs AI: YOUR VIPER HAS +10% HEALTH, DEFENSE, ATTACK AND SPEED (AI HELPER VIPERS 100%)", (255, 170, 60)
        else:
            txt2 = (f"EACH VIPER: HP {vp_hp}  DEF {vp_def}  ATK {vp_atk}      =      "
                    f"MONGOOSE x{pack_now}: HP {sq_hp}  DEF {sq_def}  ATK {sq_atk}")
            txt3, col3 = "PLAYER vs PLAYER: EQUAL POWER FOR BOTH SIDES", (150, 220, 255)
        pw2 = font_hud_sm.render(txt2, True, (170, 255, 190))
        canvas.blit(pw2, pw2.get_rect(center=(WIDTH // 2, 80)))
        pw3 = font_hud_sm.render(txt3, True, col3)
        canvas.blit(pw3, pw3.get_rect(center=(WIDTH // 2, 96)))

        if banner["timer"] > 0:
            banner["timer"] -= 1
            b = font_hud.render(banner["text"], True, (255, 230, 90))
            canvas.blit(b, b.get_rect(center=(WIDTH // 2, 118)))

        draw_level_bar(current_level)

        controls = {
            1: "[P1: WASD move, SPACE/L-CLICK bite, E/R-CLICK fury] [M: MUTE] [R: RESET] [T: MODE] [H: HELP]",
            2: "[P1: WASD+SPACE+E] [P2: ARROWS move, ENTER bite, R-SHIFT fury] [M: MUTE] [T: MODE] [H: HELP]",
            3: "[MONGOOSE: WASD+SPACE+E] [VIPER: ARROWS move, ENTER/R-CTRL spit, R-SHIFT burst] [M: MUTE] [T: MODE] [H: HELP]",
            4: "[YOUR VIPER: WASD move, SPACE/L-CLICK strike/spit, E/R-CLICK venom spray] [M: MUTE] [R: RESET] [T: MODE] [H: HELP]",
            5: "[P1 VIPER: WASD+SPACE+E] [P2 VIPER: ARROWS move, ENTER spit, R-SHIFT burst] [M: MUTE] [T: MODE] [H: HELP]",
        }[game_mode]
        if pads:
            controls += f" [PAD: {len(pads)} CONNECTED]"
        if touch["on"]:
            controls = "[TOUCH: drag left side = move | hold BITE (auto-aim) | FURY = special | tap LV to jump level]"
        canvas.blit(font_hud.render(controls, True, (0, 215, 255)), (25, HEIGHT - 35))
        ver = font_hud_sm.render(f"{GAME_NAME} {GAME_VERSION}", True, (120, 130, 160))
        canvas.blit(ver, (WIDTH - ver.get_width() - 12, HEIGHT - 20))

        if game_over:
            overlay = pygame.Surface((WIDTH, HEIGHT), pygame.SRCALPHA)
            overlay.fill((8, 10, 22, 215))
            canvas.blit(overlay, (0, 0))
            txt_over = font_big.render("MISSION FAILED", True, (255, 60, 80))
            if game_mode in (4, 5):
                txt_stats = font_hud.render(f"LEVEL {current_level} | YOUR VIPER PACK WAS BEATEN | VIPER TEAM SCORE: {viper_team['score']}", True, (220, 220, 220))
            else:
                txt_stats = font_hud.render(f"LEVEL {current_level} | SCORE: {players[0].score} | BEST: {high_score}", True, (220, 220, 220))
            txt_restart = font_hud.render("PRESS [R] TO RESTART  |  PRESS [1-9]/[0] OR CLICK A LEVEL BELOW TO WARP", True, (0, 255, 220))
            canvas.blit(txt_over, txt_over.get_rect(center=(WIDTH // 2, HEIGHT // 2 - 35)))
            canvas.blit(txt_stats, txt_stats.get_rect(center=(WIDTH // 2, HEIGHT // 2 + 15)))
            canvas.blit(txt_restart, txt_restart.get_rect(center=(WIDTH // 2, HEIGHT // 2 + 55)))
            draw_level_bar(current_level)

        if show_help:
            draw_help_screen(current_level)

        if touch["on"]:
            draw_touch_controls(big=not show_help)

        if MOBILE and _portrait:
            shade = pygame.Surface((WIDTH, HEIGHT), pygame.SRCALPHA)
            shade.fill((5, 6, 13, 235))
            canvas.blit(shade, (0, 0))
            for i, (txt, col) in enumerate((("TURN YOUR PHONE SIDEWAYS", (255, 205, 50)), ("the game plays in landscape", (200, 220, 240)))):
                t = (font_big if i == 0 else font_touch_big).render(txt, True, col)
                canvas.blit(t, t.get_rect(center=(WIDTH // 2, HEIGHT // 2 - 30 + i * 70)))

        ox, oy = 0, 0
        if shake_intensity > 0:
            ox = random.randint(-shake_intensity, shake_intensity)
            oy = random.randint(-shake_intensity, shake_intensity)
            shake_intensity = max(0, shake_intensity - 1)

        screen.fill((5, 6, 13))
        screen.blit(canvas, (ox, oy))

        pygame.display.flip()
        clock.tick(60)
        # Keep the whole screen (including the power panels) inside the browser window
        fit_clock += 1
        if fit_clock >= 30:
            fit_clock = 0
            fit_canvas_to_browser()
        await asyncio.sleep(0)

if __name__ == "__main__":
    asyncio.run(main())
