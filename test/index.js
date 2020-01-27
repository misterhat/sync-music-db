const SyncMusicDb = require('../');
const copydir = require('copy-dir');
const fs = require('fs');
const path = require('path');
const readdir = require('readdir-enhanced');
const rimrafSync = require('rimraf').sync;
const sqlite = require('sqlite');
const test = require('tape-async');

const MUSIC_DIR = `${__dirname}${path.sep}_music`;
const TMP_DIR = `${__dirname}${path.sep}music`;
const DB_FILE = `${__dirname}${path.sep}test.sqlite`;

const ABBEY_ROAD = `${TMP_DIR}${path.sep}the-beatles${path.sep}abbey-road`;
const ED_BUYS_HOUSES = `${TMP_DIR}${path.sep}ed-buys-houses`;

const KETCHUP = Buffer.from('Ketchup');
const MUSTARD = Buffer.from('Mustard');
const MUSTARD_FILE = `${ABBEY_ROAD}${path.sep}` +
    'The Beatles - Abbey Road - 11 - Mean Mr. Mustard.mp3';
const MUSTARD_POS = 0x2e;

const TIMEOUT = 10000;

function removeDb() {
    try {
        fs.unlinkSync(DB_FILE);
    } catch (e) {
        // pass
    }
}

function removeTmp() {
    try {
        rimrafSync(TMP_DIR);
    } catch (e) {
        // pass
    }
}

removeDb();
removeTmp();

fs.mkdirSync(TMP_DIR);

// copy the music to a new directory so we can modify the files
copydir.sync(MUSIC_DIR, TMP_DIR);

function afterReady(syncer) {
    return new Promise(resolve => syncer.once('ready', resolve));
}

function afterAddTrack(syncer, file) {
    return new Promise((resolve, reject) => {
        syncer.once('add', track => {
            if (track.path === file) {
                resolve();
            } else {
                reject(new Error(`unexpected file "${track.path}" added`));
            }
        });
    });
}

function afterRemove(syncer, sP) {
    return new Promise(resolve => {
        syncer.on('remove', p => {
            if (p === sP) {
                resolve();
            }
        });
    });
}

(async () => {
    const db = await sqlite.open(DB_FILE);
    const syncer = new SyncMusicDb({ db, dir: TMP_DIR });

    test('syncer.createTable() creates tracks table with attrs', async t => {
        await syncer.createTable();

        const columns = (await db.all('pragma table_info(tracks)')).map(row => {
            return row.name;
        });

        for (const attr of SyncMusicDb.TRACK_ATTRS) {
            if (columns.indexOf(attr) < 0) {
                t.fail(`"${column}" not found in tracks table`);
            }
        }
    });

    test('syncer.refresh() populates tracks table', async t => {
        t.timeoutAfter(TIMEOUT);
        syncer.on('error', err => t.error(err));

        t.notOk((await db.all('select 1 from tracks')).length,
            'initially empty');
        t.notOk(syncer.isReady, 'isReady is false');

        syncer.refresh();
        await afterReady(syncer);

        t.ok(syncer.isReady, 'isReady is true');

        const files = readdir.sync(TMP_DIR, {
            basePath: TMP_DIR,
            deep: true,
            stats: true
        });

        const fileMap = new Map();

        for (const file of files) {
            fileMap.set(file.path, Math.floor(file.mtimeMs));
        }

        await syncer.close();

        const nonMediaTracks =
            await db.all('select 1 from tracks where path like' +
                '"%not-music.txt"');

        t.notOk(nonMediaTracks.length, 'syncer did not sync non-media file');

        await db.each('select path as p, mtime from tracks', (err, track) => {
            if (err) {
                return t.error(err);
            }

            const { p, mtime } = track;
            const fileMtime = fileMap.get(p);

            if (!fileMtime) {
                t.fail(`${p} not found on local filesystem`);
            } else if (fileMtime !== mtime) {
                t.fail(`${p} database mtime (${mtime}) does not match ` +
                    `filesystem's (${fileMtime})`);
            } else {
                t.pass(`${path.basename(p)} is on filesystem with correct ` +
                    'mtime');
            }
        });

        syncer.removeAllListeners();
    });

    test('syncer responds to metadata changes', async t => {
        t.timeoutAfter(TIMEOUT);
        syncer.on('error', err => t.error(err));

        const updateTitle = title => {
            const fd = fs.openSync(MUSTARD_FILE, 'r+');
            fs.writeSync(fd, title, 0, title.length, MUSTARD_POS);
            fs.closeSync(fd);
        };

        const getTitle = async () => {
            try {
                return (await db.all('select title from tracks where path = ?',
                    MUSTARD_FILE))[0].title;
            } catch (e) {
                t.error(e);
            }
        };

        updateTitle(KETCHUP);
        syncer.refresh();
        await afterReady(syncer);

        t.equals(await getTitle(), 'Mean Mr. Ketchup',
            'syncer updated metadata after .refresh()');

        updateTitle(MUSTARD);
        await afterAddTrack(syncer, MUSTARD_FILE);
        await syncer.close();

        t.equals(await getTitle(), 'Mean Mr. Mustard',
            'syncer updated metadata live');

        syncer.removeAllListeners();
    });

    test('syncer responds to additions and removals', async t => {
        t.timeoutAfter(TIMEOUT);
        syncer.on('error', err => t.error(err));

        const mustardContents = fs.readFileSync(MUSTARD_FILE);

        rimrafSync(ABBEY_ROAD);
        syncer.refresh();
        await afterReady(syncer);

        t.notOk((await db.all(
            'select 1 from tracks where path like ?',
            `${ABBEY_ROAD}%`)).length,
            'syncer removes tracks after .refresh()');

        setImmediate(() => rimrafSync(ED_BUYS_HOUSES));
        await afterRemove(syncer, ED_BUYS_HOUSES);

        t.notOk((await db.all(
            'select 1 from tracks where path like ?',
            `${ED_BUYS_HOUSES}%`)).length,
            'syncer removes tracks live');

        const newMustardFile =
            `${__dirname}${path.sep}music${path.sep}mustard.mp3`;

        setImmediate(() => fs.writeFileSync(newMustardFile, mustardContents));
        await afterAddTrack(syncer, newMustardFile);

        t.ok((await db.all(
            'select 1 from tracks where path = ?',
            newMustardFile)).length,
            'syncer adds tracks live');

        await syncer.close();
        syncer.removeAllListeners();
    });

    test('teardown', async t => {
        await db.close();
        removeDb();
        removeTmp();
        t.end();
    });
})();
