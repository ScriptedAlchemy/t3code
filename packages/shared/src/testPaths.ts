const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|[._-](test|spec)\.[^/]+$|_test\.[^/]+$/;

/** A path-convention guess shared by the server's test walk and every client's labels. */
export const isLikelyTestPath = (path: string): boolean => TEST_PATH.test(path);
