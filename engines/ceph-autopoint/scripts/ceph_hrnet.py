"""
HRNet-W32 architecture matching the public checkpoint from:
https://huggingface.co/cwlachap/hrnet-cephalometric-landmark-detection

The structure below follows the model definition used in the public
Hugging Face demo app for this checkpoint.
"""

import torch
import torch.nn as nn


BN_MOMENTUM = 0.1


def conv3x3(in_planes, out_planes, stride=1):
    return nn.Conv2d(
        in_planes,
        out_planes,
        kernel_size=3,
        stride=stride,
        padding=1,
        bias=False,
    )


class BasicBlock(nn.Module):
    expansion = 1

    def __init__(self, inplanes, planes, stride=1, downsample=None):
        super().__init__()
        self.conv1 = conv3x3(inplanes, planes, stride)
        self.bn1 = nn.BatchNorm2d(planes, momentum=BN_MOMENTUM)
        self.relu = nn.ReLU(inplace=True)
        self.conv2 = conv3x3(planes, planes)
        self.bn2 = nn.BatchNorm2d(planes, momentum=BN_MOMENTUM)
        self.downsample = downsample

    def forward(self, x):
        residual = x
        out = self.relu(self.bn1(self.conv1(x)))
        out = self.bn2(self.conv2(out))

        if self.downsample is not None:
            residual = self.downsample(x)

        return self.relu(out + residual)


class Bottleneck(nn.Module):
    expansion = 4

    def __init__(self, inplanes, planes, stride=1, downsample=None):
        super().__init__()
        self.conv1 = nn.Conv2d(inplanes, planes, kernel_size=1, bias=False)
        self.bn1 = nn.BatchNorm2d(planes, momentum=BN_MOMENTUM)
        self.conv2 = nn.Conv2d(
            planes,
            planes,
            kernel_size=3,
            stride=stride,
            padding=1,
            bias=False,
        )
        self.bn2 = nn.BatchNorm2d(planes, momentum=BN_MOMENTUM)
        self.conv3 = nn.Conv2d(
            planes,
            planes * self.expansion,
            kernel_size=1,
            bias=False,
        )
        self.bn3 = nn.BatchNorm2d(planes * self.expansion, momentum=BN_MOMENTUM)
        self.relu = nn.ReLU(inplace=True)
        self.downsample = downsample

    def forward(self, x):
        residual = x
        out = self.relu(self.bn1(self.conv1(x)))
        out = self.relu(self.bn2(self.conv2(out)))
        out = self.bn3(self.conv3(out))

        if self.downsample is not None:
            residual = self.downsample(x)

        return self.relu(out + residual)


class HighResolutionModule(nn.Module):
    def __init__(
        self,
        num_branches,
        blocks,
        num_blocks,
        num_inchannels,
        num_channels,
        fuse_method,
        multi_scale_output=True,
    ):
        super().__init__()
        self.num_inchannels = num_inchannels
        self.num_branches = num_branches
        self.multi_scale_output = multi_scale_output
        self.branches = self._make_branches(num_branches, blocks, num_blocks, num_channels)
        self.fuse_layers = self._make_fuse_layers()
        self.relu = nn.ReLU(True)

    def _make_one_branch(self, branch_index, block, num_blocks, num_channels, stride=1):
        downsample = None
        if stride != 1 or self.num_inchannels[branch_index] != num_channels[branch_index] * block.expansion:
            downsample = nn.Sequential(
                nn.Conv2d(
                    self.num_inchannels[branch_index],
                    num_channels[branch_index] * block.expansion,
                    1,
                    stride,
                    bias=False,
                ),
                nn.BatchNorm2d(
                    num_channels[branch_index] * block.expansion,
                    momentum=BN_MOMENTUM,
                ),
            )

        layers = [block(self.num_inchannels[branch_index], num_channels[branch_index], stride, downsample)]
        self.num_inchannels[branch_index] = num_channels[branch_index] * block.expansion
        for _ in range(1, num_blocks[branch_index]):
            layers.append(block(self.num_inchannels[branch_index], num_channels[branch_index]))
        return nn.Sequential(*layers)

    def _make_branches(self, num_branches, block, num_blocks, num_channels):
        return nn.ModuleList(
            [self._make_one_branch(index, block, num_blocks, num_channels) for index in range(num_branches)]
        )

    def _make_fuse_layers(self):
        if self.num_branches == 1:
            return None

        fuse_layers = []
        for output_index in range(self.num_branches if self.multi_scale_output else 1):
            fuse_layer = []
            for branch_index in range(self.num_branches):
                if branch_index > output_index:
                    fuse_layer.append(
                        nn.Sequential(
                            nn.Conv2d(
                                self.num_inchannels[branch_index],
                                self.num_inchannels[output_index],
                                1,
                                bias=False,
                            ),
                            nn.BatchNorm2d(self.num_inchannels[output_index]),
                            nn.Upsample(scale_factor=2 ** (branch_index - output_index), mode='nearest'),
                        )
                    )
                elif branch_index == output_index:
                    fuse_layer.append(None)
                else:
                    conv3x3s = []
                    for step in range(output_index - branch_index):
                        out_channels = self.num_inchannels[output_index] if step == output_index - branch_index - 1 else self.num_inchannels[branch_index]
                        conv3x3s.append(
                            nn.Sequential(
                                nn.Conv2d(
                                    self.num_inchannels[branch_index],
                                    out_channels,
                                    3,
                                    2,
                                    1,
                                    bias=False,
                                ),
                                nn.BatchNorm2d(out_channels),
                                nn.ReLU(True) if step < output_index - branch_index - 1 else nn.Identity(),
                            )
                        )
                    fuse_layer.append(nn.Sequential(*conv3x3s))
            fuse_layers.append(nn.ModuleList(fuse_layer))

        return nn.ModuleList(fuse_layers)

    def get_num_inchannels(self):
        return self.num_inchannels

    def forward(self, x):
        if self.num_branches == 1:
            return [self.branches[0](x[0])]

        for index in range(self.num_branches):
            x[index] = self.branches[index](x[index])

        x_fuse = []
        for output_index in range(len(self.fuse_layers)):
            y = x[0] if output_index == 0 else self.fuse_layers[output_index][0](x[0])
            for branch_index in range(1, self.num_branches):
                if output_index == branch_index:
                    y = y + x[branch_index]
                else:
                    y = y + self.fuse_layers[output_index][branch_index](x[branch_index])
            x_fuse.append(self.relu(y))

        return x_fuse


blocks_dict = {
    "BASIC": BasicBlock,
    "BOTTLENECK": Bottleneck,
}


class HRNet(nn.Module):
    def __init__(self, num_joints=19):
        super().__init__()
        self.inplanes = 64
        self.conv1 = nn.Conv2d(3, 64, kernel_size=3, stride=2, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(64, momentum=BN_MOMENTUM)
        self.conv2 = nn.Conv2d(64, 64, kernel_size=3, stride=2, padding=1, bias=False)
        self.bn2 = nn.BatchNorm2d(64, momentum=BN_MOMENTUM)
        self.relu = nn.ReLU(inplace=True)
        self.layer1 = self._make_layer(Bottleneck, 64, 4)

        self.stage2_cfg = {
            "NUM_MODULES": 1,
            "NUM_BRANCHES": 2,
            "BLOCK": "BASIC",
            "NUM_BLOCKS": [4, 4],
            "NUM_CHANNELS": [32, 64],
        }
        num_channels = [channel * BasicBlock.expansion for channel in self.stage2_cfg["NUM_CHANNELS"]]
        self.transition1 = self._make_transition_layer([256], num_channels)
        self.stage2, pre_stage_channels = self._make_stage(self.stage2_cfg, num_channels)

        self.stage3_cfg = {
            "NUM_MODULES": 4,
            "NUM_BRANCHES": 3,
            "BLOCK": "BASIC",
            "NUM_BLOCKS": [4, 4, 4],
            "NUM_CHANNELS": [32, 64, 128],
        }
        num_channels = [channel * BasicBlock.expansion for channel in self.stage3_cfg["NUM_CHANNELS"]]
        self.transition2 = self._make_transition_layer(pre_stage_channels, num_channels)
        self.stage3, pre_stage_channels = self._make_stage(self.stage3_cfg, num_channels)

        self.stage4_cfg = {
            "NUM_MODULES": 3,
            "NUM_BRANCHES": 4,
            "BLOCK": "BASIC",
            "NUM_BLOCKS": [4, 4, 4, 4],
            "NUM_CHANNELS": [32, 64, 128, 256],
        }
        num_channels = [channel * BasicBlock.expansion for channel in self.stage4_cfg["NUM_CHANNELS"]]
        self.transition3 = self._make_transition_layer(pre_stage_channels, num_channels)
        self.stage4, pre_stage_channels = self._make_stage(
            self.stage4_cfg,
            num_channels,
            multi_scale_output=False,
        )

        self.final_layer = nn.Conv2d(
            pre_stage_channels[0],
            num_joints,
            kernel_size=1,
            stride=1,
            padding=0,
        )

    def _make_transition_layer(self, num_channels_pre, num_channels_cur):
        num_branches_cur = len(num_channels_cur)
        num_branches_pre = len(num_channels_pre)
        transition_layers = []

        for index in range(num_branches_cur):
            if index < num_branches_pre:
                if num_channels_cur[index] != num_channels_pre[index]:
                    transition_layers.append(
                        nn.Sequential(
                            nn.Conv2d(
                                num_channels_pre[index],
                                num_channels_cur[index],
                                3,
                                1,
                                1,
                                bias=False,
                            ),
                            nn.BatchNorm2d(num_channels_cur[index]),
                            nn.ReLU(inplace=True),
                        )
                    )
                else:
                    transition_layers.append(None)
            else:
                conv3x3s = []
                for step in range(index + 1 - num_branches_pre):
                    in_channels = num_channels_pre[-1]
                    out_channels = num_channels_cur[index] if step == index - num_branches_pre else in_channels
                    conv3x3s.append(
                        nn.Sequential(
                            nn.Conv2d(in_channels, out_channels, 3, 2, 1, bias=False),
                            nn.BatchNorm2d(out_channels),
                            nn.ReLU(inplace=True),
                        )
                    )
                transition_layers.append(nn.Sequential(*conv3x3s))

        return nn.ModuleList(transition_layers)

    def _make_layer(self, block, planes, blocks, stride=1):
        downsample = None
        if stride != 1 or self.inplanes != planes * block.expansion:
            downsample = nn.Sequential(
                nn.Conv2d(self.inplanes, planes * block.expansion, 1, stride, bias=False),
                nn.BatchNorm2d(planes * block.expansion, momentum=BN_MOMENTUM),
            )

        layers = [block(self.inplanes, planes, stride, downsample)]
        self.inplanes = planes * block.expansion
        for _ in range(1, blocks):
            layers.append(block(self.inplanes, planes))

        return nn.Sequential(*layers)

    def _make_stage(self, layer_config, num_inchannels, multi_scale_output=True):
        num_modules = layer_config["NUM_MODULES"]
        num_branches = layer_config["NUM_BRANCHES"]
        num_blocks = layer_config["NUM_BLOCKS"]
        num_channels = layer_config["NUM_CHANNELS"]
        block = blocks_dict[layer_config["BLOCK"]]
        modules = []

        for index in range(num_modules):
            reset_multi_scale = multi_scale_output or index < num_modules - 1
            modules.append(
                HighResolutionModule(
                    num_branches,
                    block,
                    num_blocks,
                    num_inchannels,
                    num_channels,
                    "SUM",
                    reset_multi_scale,
                )
            )
            num_inchannels = modules[-1].get_num_inchannels()

        return nn.Sequential(*modules), num_inchannels

    def forward(self, x):
        x = self.relu(self.bn1(self.conv1(x)))
        x = self.relu(self.bn2(self.conv2(x)))
        x = self.layer1(x)

        x_list = [self.transition1[index](x) if self.transition1[index] else x for index in range(self.stage2_cfg["NUM_BRANCHES"])]
        y_list = self.stage2(x_list)

        x_list = []
        for index in range(self.stage3_cfg["NUM_BRANCHES"]):
            source_index = min(index, len(y_list) - 1)
            if self.transition2[index]:
                x_list.append(self.transition2[index](y_list[source_index]))
            else:
                x_list.append(y_list[index])
        y_list = self.stage3(x_list)

        x_list = []
        for index in range(self.stage4_cfg["NUM_BRANCHES"]):
            source_index = min(index, len(y_list) - 1)
            if self.transition3[index]:
                x_list.append(self.transition3[index](y_list[source_index]))
            else:
                x_list.append(y_list[index])
        y_list = self.stage4(x_list)

        return self.final_layer(y_list[0])


def get_hrnet_w32(num_landmarks=19):
    return HRNet(num_joints=num_landmarks)
