// Client settings live outside the Effect layer, so a later write is visible
// without rebuilding the connection layer.
let loadBalancingWeights: Readonly<Record<string, number>> = {};

export const replaceLoadBalancingWeights = (weights: Readonly<Record<string, number>>): void => {
  loadBalancingWeights = weights;
};

export const readLoadBalancingWeights = (): Readonly<Record<string, number>> =>
  loadBalancingWeights;
