# Public release flow

This repository is a sanitized public release mirror. It uses `main` and
annotated SemVer tags for published versions.

Development, reproduction, testing, and acceptance occur in the private
canonical repository. A release is projected from an exact accepted Git tree,
checked against an allowlisted file boundary, scanned for private data and
secrets, and then reviewed before publication. Public contributions are
reproduced and tested in that canonical workflow before a later public release.

A push or tag in this repository publishes source history only. It is not an
application deployment and does not authorize market activation, paper-trading
changes, model promotion, or live broker activity.
