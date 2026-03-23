declare module 'inquirer' {
  interface Inquirer {
    prompt<T>(questions: Array<Record<string, unknown>>): Promise<T>;
  }

  const inquirer: Inquirer;
  export default inquirer;
}

