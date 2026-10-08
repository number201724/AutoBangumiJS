/**
 * Manager barrel — mirrors module/manager/__init__.py.
 */
export { TorrentManager, type ManagerResponse } from './torrent';
export { SeasonCollector, epsComplete } from './collector';
export { Renamer } from './renamer';
export {
  isStrictUpgrade,
  parseRevisionIdentity,
  replacementStagedPath,
  sameReleaseIdentity,
  type RevisionIdentity,
} from './revision-policy';
