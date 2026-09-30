/** PostgreSQL settings for tests. Each test creates and drops its own database through the admin URL. */
export const adminUrl = process.env.KIPSTER_TEST_DATABASE_URL
/** Restricted task-data login. It connects with the admin URL's host and password. */
export const taskDataRole = 'kipster_test_task_data'
/** `skip` option for tests that need PostgreSQL. */
export const noDatabase = adminUrl ? false : 'KIPSTER_TEST_DATABASE_URL is not set'
