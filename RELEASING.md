# Versioning and tags

Gauss Stream uses the desktop package version as the project release version.

For every user-visible source change:

1. Increment `desktop/package.json` and `desktop/package-lock.json` to a new
   semantic version.
2. Build the Windows portable package.
3. Commit the source with the new version.
4. Create an annotated Git tag whose name is exactly the version number, with
   no `v` prefix (for example, `0.3.3`).
5. Push the commit and tag together.
6. Publish or update the GitHub Release for that tag and attach the matching
   `Gauss-Stream-<version>.exe` artifact.

Never move or reuse an existing release tag. A later modification always gets
a new version and a new tag.
