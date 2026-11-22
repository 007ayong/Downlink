#!/bin/sh
set -eu
repo_root="$SRCROOT/../.."
commit=$(git --no-optional-locks -C "$repo_root" rev-parse --verify HEAD)
changes=$(git --no-optional-locks -C "$repo_root" status --porcelain --untracked-files=normal)
if [ -n "$changes" ]; then commit="$commit*"; fi
# Always read the source so incremental builds cannot retain an older stamp.
sed "s/__DOWNLINK_BUILD_COMMIT__/$commit/" \
  "$SRCROOT/Downlink Extension/Resources/popup-app.js" > \
  "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/popup-app.js"
