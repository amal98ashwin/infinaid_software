# Infinaid EEG Studio desktop builds

Upload the extracted repository, including .github/workflows/native.yml, to GitHub. To build without publishing, select Actions → Build desktop downloads → Run workflow. Download the artifacts after all three jobs pass. To publish directly downloadable binaries, push a new version tag such as v1.0.0. The workflow creates a GitHub Release after the packaged applications pass a synthetic EEG pipeline check on each runner.

Share the Release page with users. On x64 Windows download the EXE and double-click it. Close its console to stop the local server. On a Mac choose the ZIP for arm64 (Apple silicon) or x86_64 (Intel), extract it and open Infinaid EEG Studio.app. Use Activity Monitor to quit the background process when finished. The editor opens in the default browser and processes files on loopback. No separate Python installation is needed. The build includes no publisher signing credentials or Apple notarization. Managed devices may restrict opening unsigned downloads.

To build locally, install Python 3.11 on the target OS, install requirements.txt and pyinstaller==6.16.0 in a virtual environment, then run python build_native.py. Outputs appear under release/. The workflow validates CSV processing and export, not every recording format or manual interaction.
