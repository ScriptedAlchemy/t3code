let loadBalancingWeights: Readonly<Record<string, number>> = {};

export const replaceLoadBalancingWeights = (weights: Readonly<Record<string, number>>): void => {
  loadBalancingWeights = weights;
};

export const readLoadBalancingWeights = (): Readonly<Record<string, number>> =>
  loadBalancingWeights;
