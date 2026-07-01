from setuptools import find_packages, setup


setup(
    name="pcb-inline-inspector",
    version="0.1.0",
    description="Inline PCB inspection workflow for conveyor-based AOI.",
    package_dir={"": "src"},
    packages=find_packages("src"),
    install_requires=[
        "Flask",
        "pyserial",
        "dataclasses; python_version<'3.7'",
    ],
    entry_points={
        "console_scripts": [
            "pcb-inspector=pcb_inspector.main:main",
        ],
    },
)
