import assert from "node:assert/strict";
import test from "node:test";
import { extractYouTubeVideoUrl } from "../src/services/music.js";

const videoId = "abcDEF_123";

test("YouTube video identities preserve supported URL forms", () => {
  assert.equal(extractYouTubeVideoUrl(`https://youtu.be/${videoId}`), `https://www.youtube.com/watch?v=${videoId}`);
  assert.equal(extractYouTubeVideoUrl(`https://www.youtube.com/watch?v=${videoId}&si=tracking`), `https://www.youtube.com/watch?v=${videoId}`);
  assert.equal(extractYouTubeVideoUrl(`https://www.youtube.com/watch/?v=${videoId}`), `https://www.youtube.com/watch?v=${videoId}`);
  assert.equal(extractYouTubeVideoUrl(`https://youtube.com/shorts/${videoId}/`), `https://www.youtube.com/watch?v=${videoId}`);
});

test("YouTube video identities reject unsafe authority and path forms", () => {
  for (const value of [
    `https://user:password@youtube.com/watch?v=${videoId}`,
    `https://youtube.com:444/watch?v=${videoId}`,
    `https://youtube.com\\watch?v=${videoId}`,
    `https://youtu.be/${videoId}/extra`,
    `https://youtube.com/shorts/${videoId}/extra`,
      `https://youtube.com/./watch?v=${videoId}`,
      `https://youtube.com/shorts/../watch?v=${videoId}`,
      `https://youtu.be/${videoId}//`,
  ]) {
    assert.equal(extractYouTubeVideoUrl(value), null);
  }
});
