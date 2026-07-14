import { describe, expect, it } from 'vitest';
import {
  MIN_HEIGHT,
  MAX_HEIGHT,
  SIZE_PRESETS,
  clampHeight,
  heightForPreset,
  normalizeHeight,
  presetForHeight,
} from '../src/lib/sizing.js';

describe('clampHeight', () => {
  it('passes an in-range value through, rounded to a whole pixel', () => {
    expect(clampHeight(480)).toBe(480);
    expect(clampHeight(480.6)).toBe(481);
  });
  it('clamps to the min and max bounds', () => {
    expect(clampHeight(MIN_HEIGHT - 50)).toBe(MIN_HEIGHT);
    expect(clampHeight(MAX_HEIGHT + 5000)).toBe(MAX_HEIGHT);
  });
});

describe('normalizeHeight', () => {
  it('returns a clamped number for a usable value', () => {
    expect(normalizeHeight(480)).toBe(480);
    expect(normalizeHeight('480')).toBe(480); // config values arrive as strings too
    expect(normalizeHeight(MAX_HEIGHT + 1)).toBe(MAX_HEIGHT);
    expect(normalizeHeight(1)).toBe(MIN_HEIGHT);
  });
  it('returns null for unset, non-numeric, or non-positive input (falls back to natural size)', () => {
    expect(normalizeHeight(undefined)).toBeNull();
    expect(normalizeHeight(null)).toBeNull();
    expect(normalizeHeight('')).toBeNull();
    expect(normalizeHeight('tall')).toBeNull();
    expect(normalizeHeight(0)).toBeNull();
    expect(normalizeHeight(-100)).toBeNull();
    expect(normalizeHeight(NaN)).toBeNull();
    expect(normalizeHeight(Infinity)).toBeNull();
  });
});

describe('heightForPreset', () => {
  it('maps each preset id to its height', () => {
    expect(heightForPreset('natural')).toBeNull();
    expect(heightForPreset('small')).toBe(320);
    expect(heightForPreset('medium')).toBe(560);
    expect(heightForPreset('large')).toBe(800);
  });
  it('returns null for an unknown id', () => {
    expect(heightForPreset('huge')).toBeNull();
    expect(heightForPreset(undefined)).toBeNull();
  });
});

describe('presetForHeight', () => {
  it('is natural when unset or invalid', () => {
    expect(presetForHeight(null)).toBe('natural');
    expect(presetForHeight(undefined)).toBe('natural');
    expect(presetForHeight(0)).toBe('natural');
    expect(presetForHeight('nope')).toBe('natural');
  });
  it('round-trips each explicit preset value', () => {
    for (const p of SIZE_PRESETS) {
      if (p.height === null) continue;
      expect(presetForHeight(p.height)).toBe(p.id);
    }
  });
  it('snaps a non-preset height to the nearest preset', () => {
    expect(presetForHeight(300)).toBe('small'); // closest to 320
    expect(presetForHeight(500)).toBe('medium'); // closest to 560
    expect(presetForHeight(1500)).toBe('large'); // closest to 800 (after clamp within range)
  });
});
