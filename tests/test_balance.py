"""Balance and audio checks for Stratos_squirrel_vs_viper (the current main.py)."""
import os

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

import pygame
import pytest

import main as g


@pytest.fixture(scope="module", autouse=True)
def mixer():
    pygame.mixer.pre_init(44100, -16, 2, 512)
    pygame.init()
    pygame.mixer.init()
    yield
    pygame.quit()


STAT_KEYS = ("max_hp", "max_defense", "attack_power", "shot_cd", "special_cd", "hp", "defense")


@pytest.mark.parametrize("level", [1, 5, 10, 33, 60, 100])
def test_squirrel_and_viper_share_level_stats(level):
    squirrel = g.SquirrelPlayer(0, 0, level=level)
    for player_controlled in (False, True):
        viper = g.ViperEnemy(level=level, is_player_controlled=player_controlled)
        assert all(getattr(squirrel, k) == getattr(viper, k) for k in STAT_KEYS)


def test_pvp_viper_moves_like_the_squirrel():
    for level in (1, 20, 80):
        assert g.ViperEnemy(level=level, is_player_controlled=True).base_speed == g.SquirrelPlayer(0, 0, level=level).speed


@pytest.mark.parametrize("squirrels", [1, 2])
def test_squirrel_power_matches_viper_pack(squirrels):
    for level in range(1, 121):
        pack = g.pack_size(level, squirrels)
        assert 1 <= pack * squirrels <= g.MAX_VIPERS_ON_SCREEN
        squirrel = g.SquirrelPlayer(0, 0, level=level)
        squirrel.apply_level_up(level, power_mult=pack)
        viper = g.ViperEnemy(level=level)
        for k in ("max_hp", "max_defense", "attack_power"):
            assert getattr(squirrel, k) == getattr(viper, k) * pack


def test_pack_grows_every_five_levels():
    assert [g.pack_size(level) for level in (1, 5, 6, 10, 11, 16)] == [1, 1, 2, 2, 3, 4]
    assert g.pack_size(100) == 10 and g.pack_size(100, squirrels=2) == 5


def test_shard_power_up_is_identical_and_wears_off():
    squirrel, viper = g.SquirrelPlayer(0, 0, level=12), g.ViperEnemy(level=12)
    base = squirrel.power()
    squirrel.collect_shard()
    viper.collect_shard()
    assert squirrel.power() == viper.power() == int(base * g.SHARD_BOOST)
    for _ in range(g.SHARD_BOOST_FRAMES):
        squirrel.tick_timers()
        viper.tick_timers()
    assert squirrel.power() == viper.power() == base


def test_every_attack_has_its_own_short_sound():
    for mode in (1, 2, 3):
        raws = []
        for tool in g.ATTACK_TUNES:
            snd = g.get_attack_sfx(tool, mode, 1)
            assert snd is not None
            assert snd.get_length() <= 0.36
            raws.append(snd.get_raw()[:4000])
        assert len(set(raws)) == len(raws)


def test_sound_length_is_correct_for_the_mixer_format():
    snd = g.render_sound(0.30, lambda t: g.voice("bell", 440, t))
    assert abs(snd.get_length() - 0.30) < 0.01


@pytest.mark.parametrize("level", [1, 7, 30, 90])
def test_human_vs_ai_gets_ten_percent_more(level):
    ai_squirrel = g.SquirrelPlayer(0, 0, level=level)
    human_squirrel = g.SquirrelPlayer(0, 0, level=level)
    human_squirrel.apply_level_up(level, human_edge=True)
    for k in ("max_hp", "max_defense", "attack_power"):
        assert getattr(human_squirrel, k) == int(getattr(ai_squirrel, k) * g.HUMAN_EDGE + 0.5)
    assert human_squirrel.speed == pytest.approx(ai_squirrel.speed * g.HUMAN_EDGE)
    human_viper = g.ViperEnemy(level=level, controller=1, human_edge=True)
    assert human_viper.max_hp == human_squirrel.max_hp
    assert human_viper.base_speed == pytest.approx(ai_squirrel.speed * g.HUMAN_EDGE)


def test_player_vs_player_stays_equal():
    squirrel = g.SquirrelPlayer(0, 0, level=25)
    viper = g.ViperEnemy(level=25, controller=2)
    assert not squirrel.human_edge and not viper.human_edge
    assert (squirrel.max_hp, squirrel.max_defense, squirrel.attack_power) == (viper.max_hp, viper.max_defense, viper.attack_power)
    assert squirrel.speed == viper.base_speed


def test_taking_over_a_viper_mid_fight_grants_the_edge_once():
    viper = g.ViperEnemy(level=10)
    base = viper.max_hp
    viper.controller, viper.is_player_controlled = 1, True
    viper.grant_human_edge()
    viper.grant_human_edge()
    assert viper.max_hp == int(base * g.HUMAN_EDGE + 0.5)
    assert viper.base_speed == pytest.approx(g.fighter_speed(10) * g.HUMAN_EDGE)


def test_five_modes_exist():
    assert list(g.MODE_NAMES) == [1, 2, 3, 4, 5]
    assert g.VS_AI_MODES == (1, 2, 4, 5)


def test_mongoose_runs_ten_times_the_shared_speed():
    """User, 2026-10-10: the mongoose is swift - 10x the shared fighter speed."""
    m = g.SquirrelPlayer(400, 300, level=1)
    m.move(1, 0)
    assert m.x - 400 == pytest.approx(g.fighter_speed(1) * 10)


def test_mongoose_leap_lifts_off_and_lands():
    m = g.SquirrelPlayer(400, 300, level=1)
    m.aim_angle = 0.0
    assert m.start_jump()
    assert m.airborne() and not m.start_jump()            # no double leap
    peak = 0.0
    while m.airborne():
        m.update()
        peak = max(peak, m.lift())
    assert peak > g.JUMP_HEIGHT * 0.9
    assert m.lift() == 0.0 and m.x - 400 == pytest.approx(g.JUMP_MIN)
