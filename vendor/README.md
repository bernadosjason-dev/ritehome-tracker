# Browser ZIP reader

`fflate-0.8.2.js` is the unmodified UMD build from `fflate@0.8.2`, used by
`bom-import.js` to read XLSX ZIP entries locally. License: MIT; see
`fflate-LICENSE.txt`. No runtime CDN, external upload service or npm installation
is required by the static site.

Source: https://registry.npmjs.org/fflate/-/fflate-0.8.2.tgz

The package was fetched with npm and its tarball SHA-512 was checked against the
npm registry's published integrity before extracting `package/umd/index.js`:

```
sha512-cPJU47OaAoCbg0pBvzsgpTPhmhqI5eJjh/JIu8tPj5q+T7iLvW/JAYUqmE7KOB4R1ZyEhzBaIQpQpardBF5z8A==
```

# Supabase client

`supabase-js-2.118.0.js` is the unmodified UMD build (`dist/umd/supabase.js`) from
`@supabase/supabase-js@2.118.0`, used by `tracker.html` to sign in and talk to the
Supabase backend (`supabase-backend.js`). It defines the global `supabase`. License:
MIT; see `supabase-js-LICENSE.txt`.

Source: https://registry.npmjs.org/@supabase/supabase-js/-/supabase-js-2.118.0.tgz

Tarball integrity, checked against the npm registry before extracting:

```
sha512-FxI8UXMVC2UG7IkeiI8fuQZqq2oI3JeSuN8MPIC2RLVaoEAxKS0nqE6kii9Ewpq8f9gNPM6git1Y8f0vN/QLFw==
```

## face-api-1.7.15.js and face-models/

On-device face detection and face templates for the Attendance page (`attendance.js`): the photo is
analysed in the person's own browser and only a 128-number template leaves the phone. MIT licence
(`face-api-LICENSE.txt`). The models kept are the three the page uses: `tiny_face_detector`,
`face_landmark_68_tiny` and `face_recognition`.

Source: https://registry.npmjs.org/@vladmandic/face-api/-/face-api-1.7.15.tgz (`dist/face-api.js`, `model/`)

```
sha512-WDMmK3CfNLo8jylWqMoQgf4nIst3M0fzx1dnac96wv/dvMTN4DxC/Pq1DGtduDk1lktCamQ3MIDXFnvrdHTXDw==
```
