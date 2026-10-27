/**
 * This environment signs every commit (commit.gpgsign). A busy signing helper stalls git for
 * tens of seconds and trips the test timeout. Deskhaven's own commits already pass
 * commit.gpgsign=false when they supply an identity; tests do the same for every git they run.
 */
const count = Number(process.env.GIT_CONFIG_COUNT ?? '0');
const next = Number.isFinite(count) && count >= 0 ? count : 0;
process.env.GIT_CONFIG_COUNT = String(next + 1);
process.env[`GIT_CONFIG_KEY_${next}`] = 'commit.gpgsign';
process.env[`GIT_CONFIG_VALUE_${next}`] = 'false';
