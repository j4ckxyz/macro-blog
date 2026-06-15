import { getDb } from "../src/db/index.ts";
import { listPosts } from "../src/services/content.ts";

const db = getDb();
const allPosts = db.query("SELECT id, slug, status FROM posts").all();
console.log("All posts in DB:", allPosts);

const filteredPosts = listPosts({});
console.log("Filtered posts (listPosts({})):", filteredPosts.map(p => ({ id: p.id, slug: p.slug, status: p.status })));
