declare module "meteor/ostrio:flow-router-extra" {
  interface RouteContext {
    render(layout: string, data: Record<string, string>): void;
  }

  interface RouteOptions {
    name: string;
    action(this: RouteContext): void;
  }

  export const FlowRouter: {
    route(path: string, options: RouteOptions): void;
    getParam(name: string): string;
    getRouteName(): string;
    go(path: string): void;
  };
}

declare module "*.html";
