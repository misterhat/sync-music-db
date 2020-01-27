const audioExtensions = require('audio-extensions');
const fs = require('fs');
const mm = require('music-metadata');
const path = require('path');
const readdir = require('readdir-enhanced');
const watch = require('node-watch');
const { EventEmitter } = require('events');

// each of the columns in our database table
const TRACK_ATTRS = [
    'path', 'mtime', 'title', 'artist', 'album', 'year', 'duration', 'track_no',
    'tags', 'is_vbr', 'bitrate', 'codec', 'container'
];

const CREATE_TABLE = fs.readFileSync(path.join(__dirname, 'tracks.sql'))
    .toString();

const UPSERT_TRACK =
    `insert into tracks (${TRACK_ATTRS}) values ` +
    `(${TRACK_ATTRS.map(() => '?').join(',')}) on conflict(path) do update ` +
    `set ${TRACK_ATTRS.slice(1).map(attr => `${attr}=excluded.${attr}`)}`;

function isAudioFile(file) {
    const ext = path.extname(file).slice(1);
    return audioExtensions.indexOf(ext) !== -1;
}

class SyncMusicDb extends EventEmitter {
    constructor({ db, dir, delay = 1000, tableName = 'tracks',
        ignoreExt = true }) {
        super();

        this.db = db;
        this.dir = path.resolve(dir);
        this.tableName = tableName;
        this.delay = delay;
        this.ignoreExt = ignoreExt;

        // { path: fs.stat.mtimeMs }
        this.localMtimes = new Map();

        // is the initial sync done and are we ready to listen for new changes?
        this.isReady = false;

        // is dir up-to-date with db?
        this.isSynced = false;
    }

    // get each column of (TRACK_ATTRS) from the media file
    static async getMetaData(path) {
        try {
            const { common, format } = await mm.parseFile(path);
            const isVbr =
                format.codec === 'MP3' && /^v/i.test(format.codecProfile);

            return {
                title: common.title,
                artist: common.artist,
                album: common.album,
                year: common.year,
                duration: Math.floor(format.duration),
                track_no: (common.track ? common.track.no : null),
                tags: JSON.stringify(common.genre),
                is_vbr: isVbr,
                bitrate: Math.floor(format.bitrate / 1000),
                codec: format.codec,
                container: format.container
            };
        } catch (e) {
            return {};
        }
    }

    async createTable() {
        await this.db.exec(
            CREATE_TABLE.replace(/\$table_name/g, this.tableName));
    }

    async prepareStatements() {
        this.removeDirStmt =
            await this.db.prepare('delete from tracks where path like ?');
        this.removeTrackStmt =
            await this.db.prepare('delete from tracks where path = ?');
        this.upsertTrackStmt = await this.db.prepare(UPSERT_TRACK);
    }

    async finalizeStatements() {
        for (const prefix of ['removeDir', 'removeTrack', 'upsertTrack']) {
            await this[`${prefix}Stmt`].finalize();
            delete this[`${prefix}Stmt`];
        }
    }

    // remove all tracks that begin with directory
    async removeDbDir(dir) {
        await this.removeDirStmt.run(`${dir}${path.sep}%`);
        this.emit('remove', dir);
    }

    // remove a single track based on path
    async removeDbTrack(trackPath) {
        await this.removeTrackStmt.run(trackPath);
        this.emit('remove', trackPath);
    }

    // add a single track
    async upsertDbTrack(track) {
        await this.upsertTrackStmt.run(TRACK_ATTRS.map(attr => track[attr]));
        this.emit('add', track);
    }

    // grab every file recursively in the dir specified and set their last-
    // modified time in this.localMtimes map
    refreshLocalMtimes() {
        this.localMtimes.clear();

        return new Promise((resolve, reject) => {
            const dirStream = readdir.stream(this.dir, {
                basePath: this.dir,
                deep: true,
                stats: true
            });

            dirStream
                .on('file', stats => {
                    if (this.ignoreExt && !isAudioFile(stats.path)) {
                        return;
                    }

                    this.localMtimes.set(stats.path, Math.floor(stats.mtimeMs));
                })
                .on('end', () => resolve())
                .on('error', err => reject(err))
                .resume();
        });
    }


    // remove tracks that don't exist on the filesystem from our database,
    // and remove files from localMtimes that have up-to-date database entries
    async removeDeadTracks() {
        const query = 'select path as p, mtime from tracks';

        await this.db.exec('begin transaction');

        await this.db.each(query, async (err, { p, mtime }) => {
            if (err) {
                throw err;
            }

            const localMtime = this.localMtimes.get(p);

            if (!localMtime) {
                await this.removeDbTrack(p);
            } else if (localMtime === mtime) {
                this.localMtimes.delete(p);
            }
        });

        await this.db.exec('commit');
    }

    // get the metadata from each file in localMtimes and add them to the
    // database
    async addUpdatedTracks() {
        await this.db.exec('begin transaction');

        for (const [ path, mtime ] of this.localMtimes) {
            const track = await SyncMusicDb.getMetaData(path);
            Object.assign(track, { path, mtime });
            await this.upsertDbTrack(track);
        }

        await this.db.exec('commit');

        this.localMtimes.clear();
    }

    // listen for file updates or removals and update the database accordingly
    refreshWatcher() {
        this.watcher = watch(this.dir, {
            delay: this.delay,
            recursive: true
        }, async (evt, name) => {
            this.isSynced = false;
            this.emit('synced', this.isSynced);

            try {
                if (evt === 'update') {
                    const stats = await fs.promises.stat(name);

                    if (stats.isDirectory()) {
                        const files = await readdir(name, {
                            basePath: name,
                            deep: true,
                            stats: true
                        });

                        await this.db.exec('begin transaction');

                        for (const file of files) {
                            if (file.isDirectory()) {
                                continue;
                            }

                            if (this.ignoreExt && !isAudioFile(file.path)) {
                                continue;
                            }

                            const track =
                                await SyncMusicDb.getMetaData(file.path);

                            Object.assign(track, {
                                path: file.path,
                                mtime: Math.floor(file.mtimeMs)
                            });

                            await this.upsertDbTrack(track);
                        }

                        await this.db.exec('commit');
                    } else {
                        if (this.ignoreExt && !isAudioFile(name)) {
                            return;
                        }

                        await this.upsertDbTrack(Object.assign({
                            path: name,
                            mtime: Math.floor(stats.mtimeMs)
                        }, await SyncMusicDb.getMetaData(name)));
                    }
                } else if (evt === 'remove') {
                    // run both because if it isn't a directory, nothing will
                    // get deleted
                    await this.removeDbTrack(name);
                    await this.removeDbDir(name);
                }
            } catch (e) {
                if (e.code !== 'ENOENT') {
                    this.emit('error', e);
                }
            }

            this.isSynced = true;
            this.emit('synced', this.isSynced);
        });
    }

    // start!
    refresh() {
        this.close()
            .then(() => this.prepareStatements())
            .then(() => this.refreshLocalMtimes())
            .then(() => this.removeDeadTracks())
            .then(() => this.addUpdatedTracks())
            .then(() => {
                this.refreshWatcher();

                this.watcher.on('ready', () => {
                    this.isReady = true;
                    this.isSynced = true;
                    this.emit('synced', this.isSynced);
                    this.emit('ready');
                });
            })
            .catch(err => this.emit('error', err));

        return this;
    }

    async close() {
        if (this.removeDirStmt) {
            await this.finalizeStatements();
        }

        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }

        this.isReady = false;
        this.isSynced = false;
        this.emit('synced', this.isSynced);
    }
};

SyncMusicDb.TRACK_ATTRS = TRACK_ATTRS;

module.exports = SyncMusicDb;
