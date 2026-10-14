(function(){
 'use strict';
 // Preserve existing private share links and project bookmarks; the tracker consumes the key.
 if(/(?:^#|&)key=/.test(location.hash)||/^#p=/.test(location.hash)){
  location.replace('tracker.html?portal=projects&v=2026-10-14.1'+location.hash);
 }
})();
